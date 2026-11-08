#!/bin/sh
# Create the lifemodel log volume: one preallocated ext4 image (ADR-016 §5).
# Both installers run this script with the size their option names, followed by
# the image path and mount point they declare. It creates the image if it is
# absent, writes the store's data directory into it, and mounts nothing: the
# host's mount (the module's fileSystems entry, the installer's fstab line)
# mounts the image at /var/lib/lifemodel-logs. A lone SIZE uses the defaults
# below, the same pair both installers declare.
#
# The image is a reservation, not a sparse claim: fallocate allocates the
# blocks, so the host's free space really drops by the size asked for. The
# image's root and its data directory belong to 1000:1000, the uid the store
# and the evictor run as, so a fresh volume is writable without the kubelet's
# fsGroup. An existing image is grown to a larger size, refused a smaller one,
# and left untouched at an equal size: the log volume is never shrunk.
set -eu

# Below this the evictor's threshold is the whole volume, so every run would
# remove everything and keep nothing (ADR-016 §5). Both installers refuse less.
MINIMUM=2G

usage() {
  printf 'usage: %s check SIZE | %s SIZE [IMAGE [MOUNTPOINT]]\n' "$0" "$0" >&2
  exit 2
}

# SIZE is <number>K, <number>M or <number>G, read as 1024-based like fallocate.
size_mib() {
  number=${1%?}
  unit=${1#"$number"}
  if [ -z "$number" ] || [ -n "$(printf '%s' "$number" | tr -d '0123456789')" ]; then
    return 1
  fi
  if [ -z "$unit" ] || [ -n "$(printf '%s' "$unit" | tr -d 'KMG')" ]; then
    return 1
  fi
  if [ "$unit" = K ]; then
    printf '%s' "$(( (number + 1023) / 1024 ))"
  elif [ "$unit" = M ]; then
    printf '%s' "$number"
  else
    printf '%s' "$(( number * 1024 ))"
  fi
}

validate() {
  mib=$(size_mib "$1") || {
    echo "logs-volume: size $1 is not <number>K, <number>M or <number>G" >&2
    exit 1
  }
  if [ "$mib" -lt "$(size_mib "$MINIMUM")" ]; then
    echo "logs-volume: logs volume size $1 is below the minimum $MINIMUM" >&2
    exit 1
  fi
}

# Free space on the image's own filesystem, in KiB.
free_kb() {
  df -P -k "$(dirname "$1")" | tail -n 1 | tr -s ' ' '\t' | cut -f 4
}

# Grow the image and its filesystem. A mounted image is resized online through
# the loop device that carries it; an unmounted one is resized as a file.
grow_image() {
  fallocate -l "$1" "$2"
  device=$(losetup -j "$2" 2>/dev/null | cut -d: -f1 | head -n 1)
  if [ -n "$device" ]; then
    losetup -c "$device"
    resize2fs "$device"
  else
    resize2fs "$2"
  fi
}

[ "$#" -ge 1 ] || usage
if [ "$1" = check ]; then
  [ "$#" -eq 2 ] || usage
  validate "$2"
  exit 0
fi
[ "$#" -le 3 ] || usage

SIZE=$1
IMAGE=${2:-/var/lib/lifemodel-logs.img}
MOUNT=${3:-/var/lib/lifemodel-logs}
validate "$SIZE"
wanted_bytes=$(( mib * 1048576 ))
if [ -e "$IMAGE" ]; then
  current_bytes=$(stat -c %s "$IMAGE")
  if [ "$wanted_bytes" -eq "$current_bytes" ]; then
    exit 0
  fi
  if [ "$wanted_bytes" -lt "$current_bytes" ]; then
    echo "logs-volume: logs volume size $SIZE is smaller than the existing image's $(( current_bytes / 1048576 )) MiB; the log volume is never shrunk" >&2
    exit 1
  fi
  needed_kb=$(( (wanted_bytes - current_bytes) / 1024 ))
  avail_kb=$(free_kb "$IMAGE")
  if [ "$needed_kb" -gt "$avail_kb" ]; then
    echo "logs-volume: logs volume size $SIZE does not fit: growing needs $(( needed_kb / 1024 )) MiB but $(( avail_kb / 1024 )) MiB free on $(dirname "$IMAGE")" >&2
    exit 1
  fi
  grow_image "$SIZE" "$IMAGE"
  exit 0
fi

mkdir -p "$(dirname "$IMAGE")" "$MOUNT"
avail_kb=$(free_kb "$IMAGE")
if [ "$(( mib * 1024 ))" -gt "$avail_kb" ]; then
  echo "logs-volume: logs volume size $SIZE does not fit: $(( avail_kb / 1024 )) MiB free on $(dirname "$IMAGE")" >&2
  exit 1
fi

# The data directory and the filesystem root belong to 1000:1000, written into
# the fresh image itself: mkfs.ext4 sets the root's owner and debugfs creates
# the data directory with its owner and mode. Nothing is chowned on the host,
# which a sandboxed builder cannot do (chown fails there).
partial="$IMAGE.partial"
trap 'rm -f "$partial"' EXIT HUP INT TERM
fallocate -l "$SIZE" "$partial"
mkfs.ext4 -q -F -E root_owner=1000:1000 "$partial"
debugfs -w -R 'mkdir /data' "$partial" 2>/dev/null
debugfs -w -R 'sif /data uid 1000' "$partial" 2>/dev/null
debugfs -w -R 'sif /data gid 1000' "$partial" 2>/dev/null
debugfs -w -R 'sif /data mode 040750' "$partial" 2>/dev/null
# debugfs reports a failed command on stderr and still exits 0, so the inode is
# read back: the store needs the directory, with this owner and mode, on the
# host's own e2fsprogs too and not only on the one the flake check uses. An
# absent field leaves the expansion unchanged.
data_inode=$(debugfs -R 'stat /data' "$partial" 2>/dev/null | tr -d ' ')
if [ "${data_inode#*Type:directory}" = "$data_inode" ] ||
  [ "${data_inode#*Mode:0750}" = "$data_inode" ] ||
  [ "${data_inode#*User:1000}" = "$data_inode" ] ||
  [ "${data_inode#*Group:1000}" = "$data_inode" ]; then
  echo "logs-volume: the fresh image has no /data owned by 1000:1000 mode 0750" >&2
  exit 1
fi
# mkfs punches holes for the lazily initialised tables; reserve them again so
# the image stays a reservation and not a sparse claim (ADR-016 §5).
fallocate -l "$SIZE" "$partial"
mv "$partial" "$IMAGE"

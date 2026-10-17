#!/bin/sh
# Exercise a downloaded asset with no checkout-relative dependencies or required
# platform/name/interface arguments. Fake only the host's route discovery.
set -eu
[ "$#" -eq 2 ] || { echo 'usage: smoke-installer-bundle.sh ARCHIVE DIGEST' >&2; exit 2; }
archive=$(realpath "$1")
digest=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir "$work/clean" "$work/bin"
tar -xzf "$archive" -C "$work/clean"
cat > "$work/bin/ip" <<'EOF'
#!/bin/sh
[ "$*" = '-j -4 route show default' ] || exit 1
printf '[{"dev":"eth0","metric":100}]\n'
EOF
chmod 0755 "$work/bin/ip"
(
  cd "$work/clean"
  export PATH="$work/bin:$PATH"
  export LIFEMODEL_INSTANCE_ENV="$work/no-instance.env"
  unset ROOT_TEMPLATES LIFEMODEL_PLATFORM_URL LIFEMODEL_PLATFORM_TAG LIFEMODEL_PLATFORM_DIGEST
  test -x scripts/install.sh
  test -f deploy/cli/lifemodel.mjs
  test -f deploy/cli/wait-ready.mjs
  sh scripts/install.sh --render-only "$work/rendered"
)
grep -Fx "    digest: $digest" "$work/rendered/ocirepository.yaml"
grep -Fx '  url: "oci://ghcr.io/shady2k/lifemodel-platform"' "$work/rendered/ocirepository.yaml"
grep -Fx '    provider: cosign' "$work/rendered/ocirepository.yaml"
grep -Fx "  LIFEMODEL_NAME: 'lifemodel'" "$work/rendered/instance.yaml"
grep -F 'boot-lifemodel.local eth0' "$work/rendered/systemd/lifemodel-mdns-boot-lifemodel-local.service"
if grep -v '^[[:space:]]*#' "$work/rendered/ocirepository.yaml" | grep -E '@[A-Z_]+@' || grep -F '${LIFEMODEL_NAME}' "$work/rendered/instance.yaml"; then
  echo 'installer left an unresolved template value' >&2; exit 1
fi

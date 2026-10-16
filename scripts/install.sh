#!/bin/sh
# lifemodel generic-Linux installer (task lifemodel-lut.3.3).
#
# Installs exactly what the NixOS module (deploy/nixos/default.nix) installs,
# on a generic Linux host (Ubuntu/Debian), per ADR-010 "the one command":
#   1. k3s with embedded etcd (--cluster-init), pinned to the version the
#      flake.locked nixpkgs nixos-26.05 ships (K3S_VERSION below; the flake
#      check compares this string against pkgs.k3s.version).
#   2. Flux v2.9.6: the same install.yaml URL and sha256 as the module's
#      pkgs.fetchurl, verified with sha256sum before anything is applied.
#   3. The root platform source: the SAME templates in deploy/root/, rendered
#      with the SAME substitutions as deploy/nixos/default.nix
#      (@PLATFORM_URL@ @PLATFORM_INSECURE@ @REF_BLOCK@ @VERIFY_BLOCK@),
#      applied as the OCIRepository and the root Kustomization.
#
# POSIX sh, set -eu. An existing flux-system namespace that is not labelled
# app.kubernetes.io/managed-by=lifemodel is refused, exactly like the module.
# --render-only DIR writes the rendered root objects and exits without
# touching the host (the flake check and the test use this mode).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MDNS_SOURCE="$SCRIPT_DIR/../deploy/mdns"
[ -d "$MDNS_SOURCE" ] || MDNS_SOURCE="$SCRIPT_DIR/deploy/mdns"
ROOT_TEMPLATES=${ROOT_TEMPLATES:-"$SCRIPT_DIR/../deploy/root"}

K3S_VERSION="1.35.8+k3s1"
FLUX_VERSION="v2.9.6"
FLUX_INSTALL_URL="https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml"
FLUX_INSTALL_SHA256="9c1fda7e401429531ed1478f67ba06b3edff6513b75da7ee47bde9f1c4d4251c"

PLATFORM_URL=""
PLATFORM_TAG=""
PLATFORM_DIGEST=""
VERIFY_MODE="keyless"
PUBLIC_KEY_FILE=""
ISSUER="^https://token\\.actions\\.githubusercontent\\.com$"
SUBJECT_REGEX="^https://github\\.com/shady2k/lifemodel/\\.github/workflows/release\\.yml@refs/tags/v.*$"
INSECURE_REGISTRY=false
RENDER_ONLY_DIR=""
INSTANCE_NAME="lifemodel"
LAN_INTERFACE=""
KUBECTL=""

usage() {
  cat <<EOF
Usage: install.sh --platform-url URL (--tag TAG | --digest DIGEST) [options]

Required:
  --platform-url URL       OCI URL of the signed platform artifact
  --tag TAG                artifact tag (exactly one of --tag / --digest)
  --digest DIGEST          artifact digest (exactly one of --tag / --digest)

Verification (defaults are the NixOS module's defaults):
  --verify MODE            keyless (default) or key
  --issuer REGEX           keyless OIDC issuer regex
  --subject-regex REGEX    keyless certificate subject regex
  --public-key-file FILE   PEM public key; REQUIRED when --verify key

Cluster:
  --name NAME              instance DNS label (default: lifemodel)
  --lan-interface IFACE    LAN interface (default: default IPv4 route)
  --insecure-registry      render insecure: true (plain-HTTP registry)
  --render-only DIR        write the rendered root objects to DIR and exit
                           without touching the host
  --root-templates DIR     use shared templates from DIR (for packaging/checks)
  -h, --help               show this help
EOF
}

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    die "$1 requires a value"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform-url)      require_value "$@"; PLATFORM_URL=$2; shift 2 ;;
    --tag)               require_value "$@"; PLATFORM_TAG=$2; shift 2 ;;
    --digest)            require_value "$@"; PLATFORM_DIGEST=$2; shift 2 ;;
    --verify)            require_value "$@"; VERIFY_MODE=$2; shift 2 ;;
    --public-key-file)   require_value "$@"; PUBLIC_KEY_FILE=$2; shift 2 ;;
    --issuer)            require_value "$@"; ISSUER=$2; shift 2 ;;
    --subject-regex)     require_value "$@"; SUBJECT_REGEX=$2; shift 2 ;;
    --name)               require_value "$@"; INSTANCE_NAME=$2; shift 2 ;;
    --lan-interface)      require_value "$@"; LAN_INTERFACE=$2; shift 2 ;;
    --insecure-registry) INSECURE_REGISTRY=true; shift ;;
    --render-only)       require_value "$@"; RENDER_ONLY_DIR=$2; shift 2 ;;
    --root-templates)    require_value "$@"; ROOT_TEMPLATES=$2; shift 2 ;;
    -h|--help)           usage; exit 0 ;;
    *)                   die "unknown option: $1" ;;
  esac
done

[ -n "$PLATFORM_URL" ] || die "--platform-url is required"
case "$INSTANCE_NAME" in
  ''|[!a-z]*|*[!a-z0-9-]*|-*|*-|y|n|yes|no|true|false|on|off|null|~)
    die "--name must be a non-reserved lowercase DNS-1035 label (1-57 characters)" ;;
esac
[ "${#INSTANCE_NAME}" -le 57 ] || die "--name must be a non-reserved lowercase DNS-1035 label (1-57 characters)"
case "$LAN_INTERFACE" in *[!A-Za-z0-9_.:-]* ) die "--lan-interface must contain only safe interface characters" ;; esac
[ "${#LAN_INTERFACE}" -le 15 ] || die "--lan-interface must be at most 15 characters"
case "$LAN_INTERFACE" in cni*|flannel*|veth*|wg*|tun*|tailscale*) [ -z "$LAN_INTERFACE" ] || die "refusing non-LAN interface: $LAN_INTERFACE" ;; esac
LIFEMODEL_STATE_DIR=${LIFEMODEL_STATE_DIR:-/var/lib/lifemodel}
if [ -n "$PLATFORM_TAG" ] && [ -n "$PLATFORM_DIGEST" ]; then
  die "--tag and --digest are mutually exclusive; pass exactly one"
fi
if [ -z "$PLATFORM_TAG" ] && [ -z "$PLATFORM_DIGEST" ]; then
  die "--tag or --digest is required; pass exactly one"
fi
case "$VERIFY_MODE" in
  keyless) ;;
  key)
    [ -n "$PUBLIC_KEY_FILE" ] || die "--public-key-file is required when --verify key"
    ;;
  *)
    die "--verify must be keyless or key; got: $VERIFY_MODE"
    ;;
esac

# ---------------------------------------------------------------------------
# Rendering: the same substitutions as deploy/nixos/default.nix, applied to
# the same templates in deploy/root/. @REF_BLOCK@ and @VERIFY_BLOCK@ sit on
# their own template lines and are replaced by whole blocks; the other two
# placeholders are replaced in place.
# ---------------------------------------------------------------------------

render_root_objects() {
  render_dir=$1
  templates_dir="${ROOT_TEMPLATES:-$SCRIPT_DIR/../deploy/root}"
  [ -f "$templates_dir/ocirepository.yaml" ] || die "missing template: $templates_dir/ocirepository.yaml"
  [ -f "$templates_dir/kustomization.yaml" ] || die "missing template: $templates_dir/kustomization.yaml"

  yaml_quote() {
    case "$1" in
      *'
'*) die "YAML scalar values must not contain a newline" ;;
    esac
    printf "'"
    printf '%s' "$1" | sed "s/'/''/g"
    printf "'"
  }
  if [ -n "$PLATFORM_DIGEST" ]; then
    ref_block="    digest: $PLATFORM_DIGEST"
  else
    quoted_tag=$(yaml_quote "$PLATFORM_TAG")
    ref_block="    tag: $quoted_tag"
  fi
  if [ "$VERIFY_MODE" = "keyless" ]; then
    quoted_issuer=$(yaml_quote "$ISSUER")
    quoted_subject=$(yaml_quote "$SUBJECT_REGEX")
    verify_block="    matchOIDCIdentity:
      - issuer: $quoted_issuer
        subject: $quoted_subject"
  else
    verify_block="    secretRef:
      name: platform-cosign"
  fi
  if [ "$INSECURE_REGISTRY" = "true" ]; then
    insecure_value=true
  else
    insecure_value=false
  fi

  while IFS= read -r template_line || [ -n "$template_line" ]; do
    case "$template_line" in
      "@REF_BLOCK@")
        printf '%s\n' "$ref_block"
        ;;
      "@VERIFY_BLOCK@")
        printf '%s\n' "$verify_block"
        ;;
      *)
        rendered=$(printf '%s\n' "$template_line" \
          | sed -e "s|@PLATFORM_URL@|$PLATFORM_URL|" -e "s|@PLATFORM_INSECURE@|$insecure_value|")
        printf '%s\n' "$rendered"
        ;;
    esac
  done < "$templates_dir/ocirepository.yaml" > "$render_dir/ocirepository.yaml"
  cp "$templates_dir/kustomization.yaml" "$render_dir/kustomization.yaml"
  sed "s/\${LIFEMODEL_NAME}/$INSTANCE_NAME/" "$templates_dir/instance.yaml" > "$render_dir/instance.yaml"
  interface=$LAN_INTERFACE
  if [ -z "$interface" ]; then
    routes=$(ip -j -4 route show default) || die "cannot read IPv4 default routes; pass --lan-interface"
    interface=$(printf '%s' "$routes" | node -e '
let data=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => data += c); process.stdin.on("end", () => {
  let routes;
  try { routes = JSON.parse(data); } catch { process.exit(2); }
  if (!Array.isArray(routes)) process.exit(2);
  const candidates = routes.filter(r => r && typeof r.dev === "string" && r.dev.length > 0)
    .map((r, i) => ({ dev: r.dev, metric: Number.isFinite(r.metric) ? r.metric : 0, i }))
    .sort((a, b) => a.metric - b.metric || a.i - b.i);
  if (candidates.length) process.stdout.write(candidates[0].dev);
});
' ) || die "cannot parse IPv4 default routes; pass --lan-interface"
  fi
  [ -n "$interface" ] || die "cannot determine a usable IPv4 default-route interface; pass --lan-interface"
  case "$interface" in *[!A-Za-z0-9_.:-]*) die "invalid LAN interface name" ;; esac
  [ "${#interface}" -le 15 ] || die "LAN interface name exceeds 15 characters"
  case "$interface" in cni*|flannel*|veth*|wg*|tun*|tailscale*) die "refusing non-LAN interface: $interface" ;; esac
  mdns_source=$MDNS_SOURCE
  mkdir -p "$render_dir/systemd"
  for dns_name in "$INSTANCE_NAME.local" "boot-$INSTANCE_NAME.local" "vault-$INSTANCE_NAME.local"; do
    unit_name=$(printf '%s' "$dns_name" | tr '.' '-')
    sed -e "s|@PUBLISHER@|/usr/lib/lifemodel/publish-name|g" -e "s|@NAME@|$dns_name|g" -e "s|@INTERFACE@|$interface|g" "$mdns_source/publisher.service.in" > "$render_dir/systemd/lifemodel-mdns-$unit_name.service"
  done
  cp "$mdns_source/publish-name" "$render_dir/publish-name"
}

# Render-only mode: write the rendered objects and exit, touching nothing.
if [ -n "$RENDER_ONLY_DIR" ]; then
  mkdir -p "$RENDER_ONLY_DIR"
  render_root_objects "$RENDER_ONLY_DIR"
  exit 0
fi

# ---------------------------------------------------------------------------
# Host installation (render-only mode exited above).
# ---------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "must run as root (k3s and the Flux bootstrap need it)"
if ! command -v node >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "Node.js is required (install nodejs or use a Debian/Ubuntu host with apt-get)"
  apt-get update
  apt-get install -y nodejs
fi
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 18 ] || die "Node.js 18 or newer is required; found $(node --version)"
command -v apt-get >/dev/null 2>&1 || die "apt-get is required to install avahi-daemon and avahi-utils"
apt-get update
apt-get install -y avahi-daemon avahi-utils
lan_interface=$LAN_INTERFACE
if [ -z "$lan_interface" ]; then
  routes=$(ip -j -4 route show default) || die "cannot read IPv4 default routes; pass --lan-interface"
  lan_interface=$(printf '%s' "$routes" | node -e '
let data=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => data += c); process.stdin.on("end", () => {
  let routes;
  try { routes = JSON.parse(data); } catch { process.exit(2); }
  if (!Array.isArray(routes)) process.exit(2);
  const candidates = routes.filter(r => r && typeof r.dev === "string" && r.dev.length > 0)
    .map((r, i) => ({ dev: r.dev, metric: Number.isFinite(r.metric) ? r.metric : 0, i }))
    .sort((a, b) => a.metric - b.metric || a.i - b.i);
  if (candidates.length) process.stdout.write(candidates[0].dev);
});
' ) || die "cannot parse IPv4 default routes; pass --lan-interface"
fi
[ -n "$lan_interface" ] || die "cannot determine a usable IPv4 default-route interface; pass --lan-interface"
case "$lan_interface" in *[!A-Za-z0-9_.:-]*|'') die "invalid LAN interface name" ;; esac
[ "${#lan_interface}" -le 15 ] || die "LAN interface name exceeds 15 characters"
case "$lan_interface" in cni*|flannel*|veth*|wg*|tun*|tailscale*) die "refusing non-LAN interface: $lan_interface" ;; esac
host_root=${LIFEMODEL_INSTALL_ROOT:-}
mdns_source=$MDNS_SOURCE
mkdir -p "$host_root/usr/lib/lifemodel" "$host_root/etc/systemd/system" "$host_root/etc/avahi"
install -m 0755 "$MDNS_SOURCE/publish-name" "$host_root/usr/lib/lifemodel/publish-name"
for dns_name in "$INSTANCE_NAME.local" "boot-$INSTANCE_NAME.local" "vault-$INSTANCE_NAME.local"; do
  unit_name=$(printf '%s' "$dns_name" | tr '.' '-')
  sed -e "s|@PUBLISHER@|/usr/lib/lifemodel/publish-name|g" -e "s|@NAME@|$dns_name|g" -e "s|@INTERFACE@|$lan_interface|g" "$mdns_source/publisher.service.in" > "$host_root/etc/systemd/system/lifemodel-mdns-$unit_name.service"
done
avahi_conf="$host_root/etc/avahi/avahi-daemon.conf"
[ -n "$host_root" ] || avahi_conf=/etc/avahi/avahi-daemon.conf
[ -f "$avahi_conf" ] || : > "$avahi_conf"
updated=$(mktemp)
awk -v iface="$lan_interface" '
function trimleft(value) { sub(/^[[:space:]]+/, "", value); return value }
function emit_setting() { print "allow-interfaces=" iface; wrote=1 }
BEGIN { section=""; server_groups=0; wrote=0 }
{
  line=$0
  header=trimleft(line)
  if (header ~ /^\[[^]]+\]/) {
    if (tolower(section) == "server" && !wrote) emit_setting()
    section=substr(header, 2, index(header, "]")-2)
    section=tolower(section)
    if (section == "server") server_groups++
    print line
    next
  }
  if (tolower(section) == "server" && line ~ /^[[:space:]]*[Aa][Ll][Ll][Oo][Ww]-[Ii][Nn][Tt][Ee][Rr][Ff][Aa][Cc][Ee][Ss][[:space:]]*=/) {
    if (!wrote) emit_setting()
    next
  }
  print line
}
END {
  if (tolower(section) == "server" && !wrote) emit_setting()
  if (server_groups == 0) { print "[server]"; emit_setting() }
}
'  "$avahi_conf" > "$updated"
if ! cmp -s "$updated" "$avahi_conf"; then cat "$updated" > "$avahi_conf"; avahi_changed=1; else avahi_changed=0; fi
rm -f "$updated"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable avahi-daemon.service
  if [ "$avahi_changed" -eq 1 ]; then systemctl restart avahi-daemon.service; else systemctl start avahi-daemon.service; fi
  for dns_name in "$INSTANCE_NAME.local" "boot-$INSTANCE_NAME.local" "vault-$INSTANCE_NAME.local"; do
    unit_name=$(printf '%s' "$dns_name" | tr '.' '-')
    systemctl enable --now "lifemodel-mdns-$unit_name.service"
  done
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow in on "$lan_interface" to any port 80 proto tcp
  ufw allow in on "$lan_interface" to any port 443 proto tcp
  ufw allow in on "$lan_interface" to any port 5353 proto udp
elif [ -z "$host_root" ]; then
  echo "NOTE: ensure host firewall allows TCP 80/443 and UDP 5353 on $lan_interface only" >&2
fi
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v flock >/dev/null 2>&1 || die "flock is required"

if command -v k3s >/dev/null 2>&1; then
  installed_version=$(k3s --version | awk 'NR==1 {print $3}')
  if [ "$installed_version" != "v$K3S_VERSION" ]; then
    die "k3s $installed_version is installed but this installer pins v$K3S_VERSION; refusing to change it"
  fi
else
  curl -fsSL https://get.k3s.io | INSTALL_K3S_VERSION="v$K3S_VERSION" sh -s - server --cluster-init
fi

if [ -n "${KUBECONFIG:-}" ] && [ -f "$KUBECONFIG" ]; then
  KUBECTL="k3s kubectl --kubeconfig $KUBECONFIG"
else
  KUBECTL="k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml"
fi

cluster_ready=0
for attempt in $(seq 1 60); do
  if $KUBECTL get nodes >/dev/null 2>&1; then
    cluster_ready=1
    break
  fi
  sleep 2
done
[ "$cluster_ready" -eq 1 ] || die "k3s did not become ready"

# Refuse an unlabelled existing flux-system exactly like the module does.
if $KUBECTL get namespace flux-system >/dev/null 2>&1; then
  owner=$($KUBECTL get namespace flux-system -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')
  if [ "$owner" != "lifemodel" ]; then
    die "Refusing to modify flux-system: namespace is not labelled as managed by lifemodel"
  fi
fi

# Pinned Flux: same URL, same sha256 as the module's pkgs.fetchurl.
flux_manifest=$(mktemp)
render_dir=$(mktemp -d)
trap 'rm -rf "$flux_manifest" "$render_dir"' EXIT INT TERM
curl -fsSL "$FLUX_INSTALL_URL" -o "$flux_manifest"
printf '%s  %s\n' "$FLUX_INSTALL_SHA256" "$flux_manifest" | sha256sum -c - >/dev/null \
  || die "Flux manifest sha256 mismatch for $FLUX_INSTALL_URL (expected $FLUX_INSTALL_SHA256)"
# Claim the namespace before applying Flux so a partial or interrupted apply
# can be retried. This field manager owns only the lifemodel marker.
printf '%s\n' \
  'apiVersion: v1' \
  'kind: Namespace' \
  'metadata:' \
  '  name: flux-system' \
  '  labels:' \
  '    app.kubernetes.io/managed-by: lifemodel' \
  | $KUBECTL apply --server-side --field-manager=lifemodel-namespace -f -

$KUBECTL apply --server-side -f "$flux_manifest"

# Key mode: create the platform-cosign Secret from the trusted public key.
if [ "$VERIFY_MODE" = "key" ]; then
  [ -f "$PUBLIC_KEY_FILE" ] || die "--public-key-file does not name a readable file"
  install -d -m 0700 /run/lifemodel
  install -m 0600 "$PUBLIC_KEY_FILE" /run/lifemodel/platform-cosign.pub
  $KUBECTL -n flux-system create secret generic platform-cosign \
    --from-file=cosign.pub=/run/lifemodel/platform-cosign.pub \
    --dry-run=client -o yaml | $KUBECTL apply --server-side -f -
fi

LIFEMODEL_INSTALL_ROOT=${LIFEMODEL_INSTALL_ROOT:-}
# The verified root platform source, rendered from the shared templates.
render_root_objects "$render_dir"
mkdir -p "$LIFEMODEL_STATE_DIR"
if [ -n "${LIFEMODEL_LOCK_FD:-}" ] && [ "${LIFEMODEL_LOCK_HELD:-0}" = 1 ]; then
  flock -x "$LIFEMODEL_LOCK_FD"
else
  exec 9>"$LIFEMODEL_STATE_DIR/lock"
  flock -x 9
  LIFEMODEL_LOCK_FD=9
  LIFEMODEL_LOCK_HELD=1
fi
# Establish the fixed instance identity before publishing any name-dependent
# root objects. A local state loss is recovered from the durable root ConfigMap.
installed_name=""
if [ -f "$LIFEMODEL_STATE_DIR/instance-name" ]; then
  installed_name=$(cat "$LIFEMODEL_STATE_DIR/instance-name")
else
  identity_error=$(mktemp)
  if installed_name=$($KUBECTL -n flux-system get configmap lifemodel-instance -o jsonpath='{.data.LIFEMODEL_NAME}' 2>"$identity_error"); then
    [ -n "$installed_name" ] || { rm -f "$identity_error"; die "existing lifemodel-instance ConfigMap has no LIFEMODEL_NAME"; }
  else
    if grep -Fqi '(NotFound)' "$identity_error"; then installed_name="";
    else cat "$identity_error" >&2; rm -f "$identity_error"; die "cannot determine existing instance identity"; fi
  fi
  rm -f "$identity_error"
fi
if [ -n "$installed_name" ] && [ "$installed_name" != "$INSTANCE_NAME" ]; then
  die "instance name is fixed as $installed_name; reinstall to change it"
fi
printf '%s\n' "$INSTANCE_NAME" > "$LIFEMODEL_STATE_DIR/instance-name.tmp"
chmod 0600 "$LIFEMODEL_STATE_DIR/instance-name.tmp"
mv "$LIFEMODEL_STATE_DIR/instance-name.tmp" "$LIFEMODEL_STATE_DIR/instance-name"
if [ -n "$PLATFORM_DIGEST" ]; then configured_ref="digest=$PLATFORM_DIGEST"; else configured_ref="tag=$PLATFORM_TAG"; fi
if [ -f "$SCRIPT_DIR/deploy/cli/lifemodel.mjs" ]; then cli_source="$SCRIPT_DIR/deploy/cli/lifemodel.mjs"; else cli_source="$SCRIPT_DIR/../deploy/cli/lifemodel.mjs"; fi
effective_oci="$render_dir/ocirepository-effective.yaml"
LIFEMODEL_STATE_DIR="$LIFEMODEL_STATE_DIR" LIFEMODEL_LOCK_FD="$LIFEMODEL_LOCK_FD" LIFEMODEL_LOCK_HELD=1 node "$cli_source" render-ref "$render_dir/ocirepository.yaml" "$configured_ref" > "$effective_oci"
effective_ref=$(LIFEMODEL_STATE_DIR="$LIFEMODEL_STATE_DIR" LIFEMODEL_LOCK_FD="$LIFEMODEL_LOCK_FD" LIFEMODEL_LOCK_HELD=1 node "$cli_source" effective-ref "$configured_ref")
LIFEMODEL_KUBECTL="$KUBECTL" LIFEMODEL_LOCK_FD="$LIFEMODEL_LOCK_FD" LIFEMODEL_LOCK_HELD=1 LIFEMODEL_STATE_DIR="$LIFEMODEL_STATE_DIR" node "$cli_source" assert-root-ownership
$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$effective_oci"
$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$render_dir/instance.yaml"
$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$render_dir/kustomization.yaml"

# Install the recovery CLI and durably retain this successfully applied pin.
# These roots are configurable so installer tests can exercise the real install
# path without writing into the host's /usr/local or /var/lib directories.
cli_lib_dir="$LIFEMODEL_INSTALL_ROOT/usr/lib/lifemodel"
cli_bin_dir="$LIFEMODEL_INSTALL_ROOT/usr/local/bin"
bundle_dir="$cli_lib_dir/bootstrap"
bundle_templates="$bundle_dir/root"
bundle_script="$bundle_dir/install.sh"
bundle_key="$bundle_dir/verification/public-key.pem"
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
newline='
'
case "$LIFEMODEL_STATE_DIR" in *"$newline"*) die 'state directory must not contain a newline' ;; esac
quoted_cli=$(shell_quote "$cli_lib_dir/lifemodel.mjs")
quoted_state=$(shell_quote "$LIFEMODEL_STATE_DIR")
quoted_install_root=$(shell_quote "$LIFEMODEL_INSTALL_ROOT")
quoted_ref=$(shell_quote "$configured_ref")
quoted_kubectl=$(shell_quote "$KUBECTL")
install -d -m 0755 "$bundle_dir" "$bundle_templates" "$bundle_dir/verification"
if [ "$ROOT_TEMPLATES" != "$bundle_templates" ]; then
  cp "$ROOT_TEMPLATES/ocirepository.yaml" "$bundle_templates/ocirepository.yaml"
  cp "$ROOT_TEMPLATES/kustomization.yaml" "$bundle_templates/kustomization.yaml"
  cp "$ROOT_TEMPLATES/instance.yaml" "$bundle_templates/instance.yaml"
fi
mdns_source=$MDNS_SOURCE
if [ -f "$mdns_source/publish-name" ] && [ "$mdns_source" != "$bundle_dir/deploy/mdns" ]; then
  install -d -m 0755 "$bundle_dir/deploy/mdns"
  install -m 0755 "$mdns_source/publish-name" "$bundle_dir/deploy/mdns/publish-name"
  install -m 0644 "$mdns_source/publisher.service.in" "$bundle_dir/deploy/mdns/publisher.service.in"
fi
if [ "$SCRIPT_DIR/install.sh" != "$bundle_script" ]; then install -m 0755 "$SCRIPT_DIR/install.sh" "$bundle_script"; fi
install -d -m 0755 "$bundle_dir/deploy/cli"
if [ "$cli_source" != "$bundle_dir/deploy/cli/lifemodel.mjs" ]; then
  install -m 0644 "$cli_source" "$bundle_dir/deploy/cli/lifemodel.mjs"
fi
if [ "$VERIFY_MODE" = "key" ] && [ "$PUBLIC_KEY_FILE" != "$bundle_key" ]; then install -m 0600 "$PUBLIC_KEY_FILE" "$bundle_key"; fi
apply_args=$(node -e 'const [script,url,name,tag,digest,mode,issuer,subject,key,insecure,templates]=process.argv.slice(1); const a=[script,"--platform-url",url,"--name",name]; if(digest) a.push("--digest",digest); else a.push("--tag",tag); a.push("--verify",mode); if(mode==="key") a.push("--public-key-file",key); if(mode==="keyless") a.push("--issuer",issuer,"--subject-regex",subject); if(insecure==="true") a.push("--insecure-registry"); a.push("--root-templates",templates); process.stdout.write(JSON.stringify(a));' -- "$bundle_script" "$PLATFORM_URL" "$INSTANCE_NAME" "$PLATFORM_TAG" "$PLATFORM_DIGEST" "$VERIFY_MODE" "$ISSUER" "$SUBJECT_REGEX" "$bundle_key" "$INSECURE_REGISTRY" "$bundle_templates")
quoted_args=$(shell_quote "$apply_args")
install -d -m 0755 "$cli_lib_dir" "$cli_bin_dir" "$LIFEMODEL_STATE_DIR"
install -m 0644 "$cli_source" "$cli_lib_dir/lifemodel.mjs"
cat > "$cli_bin_dir/lifemodel" <<EOF
#!/bin/sh
LIFEMODEL_STATE_DIR=$quoted_state LIFEMODEL_INSTALL_ROOT=$quoted_install_root LIFEMODEL_CONFIGURED_REF=$quoted_ref LIFEMODEL_KUBECTL=$quoted_kubectl LIFEMODEL_APPLY_SCRIPT=/bin/sh LIFEMODEL_APPLY_ARGS=$quoted_args exec node $quoted_cli "\$@"
EOF
chmod 0755 "$cli_bin_dir/lifemodel"
LIFEMODEL_LOCK_FD="$LIFEMODEL_LOCK_FD" LIFEMODEL_LOCK_HELD=1 LIFEMODEL_STATE_DIR="$LIFEMODEL_STATE_DIR" LIFEMODEL_CONFIGURED_REF="$configured_ref" \
  "$cli_bin_dir/lifemodel" record-applied "$effective_ref"
printf 'install.sh: done (k3s v%s, Flux %s, platform source applied)\n' "$K3S_VERSION" "$FLUX_VERSION"

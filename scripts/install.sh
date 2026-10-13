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
    --insecure-registry) INSECURE_REGISTRY=true; shift ;;
    --render-only)       require_value "$@"; RENDER_ONLY_DIR=$2; shift 2 ;;
    --root-templates)    require_value "$@"; ROOT_TEMPLATES=$2; shift 2 ;;
    -h|--help)           usage; exit 0 ;;
    *)                   die "unknown option: $1" ;;
  esac
done

[ -n "$PLATFORM_URL" ] || die "--platform-url is required"
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
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
if ! command -v node >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "Node.js is required (install nodejs or use a Debian/Ubuntu host with apt-get)"
  apt-get update
  apt-get install -y nodejs
fi

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

# The verified root platform source, rendered from the shared templates.
render_root_objects "$render_dir"
$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap --force-conflicts -f "$render_dir/ocirepository.yaml"
$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap --force-conflicts -f "$render_dir/kustomization.yaml"

# Install the recovery CLI and durably retain this successfully applied pin.
# These roots are configurable so installer tests can exercise the real install
# path without writing into the host's /usr/local or /var/lib directories.
LIFEMODEL_INSTALL_ROOT=${LIFEMODEL_INSTALL_ROOT:-}
LIFEMODEL_STATE_DIR=${LIFEMODEL_STATE_DIR:-/var/lib/lifemodel}
cli_lib_dir="$LIFEMODEL_INSTALL_ROOT/usr/local/lib/lifemodel"
cli_bin_dir="$LIFEMODEL_INSTALL_ROOT/usr/local/bin"
install -d -m 0755 "$cli_lib_dir" "$cli_bin_dir" "$LIFEMODEL_STATE_DIR"
install -m 0644 "$SCRIPT_DIR/../deploy/cli/lifemodel.mjs" "$cli_lib_dir/lifemodel.mjs"
cat > "$cli_bin_dir/lifemodel" <<EOF
#!/bin/sh
exec node "$cli_lib_dir/lifemodel.mjs" "\$@"
EOF
chmod 0755 "$cli_bin_dir/lifemodel"
if [ -n "$PLATFORM_DIGEST" ]; then
  configured_ref="digest=$PLATFORM_DIGEST"
else
  configured_ref="tag=$PLATFORM_TAG"
fi
LIFEMODEL_HISTORY="$LIFEMODEL_STATE_DIR/platform-history" "$cli_bin_dir/lifemodel" record-applied "$configured_ref"

printf 'install.sh: done (k3s v%s, Flux %s, platform source applied)\n' "$K3S_VERSION" "$FLUX_VERSION"

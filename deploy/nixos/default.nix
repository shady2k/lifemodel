{ config, lib, pkgs, lifemodelK3s, ... }:
let
  cfg = config.services.lifemodel;
  inherit (lib) mkEnableOption mkOption types;
  rootDir = ../root;
  yamlQuote = value: "'${lib.replaceStrings [ "'" ] [ "''" ] value}'";
  refBlock = if cfg.platform.digest != null
    then "    digest: ${cfg.platform.digest}"
    else "    tag: ${yamlQuote cfg.platform.tag}";
  verifyBlock = if cfg.verify.mode == "keyless" then
    "    matchOIDCIdentity:\n      - issuer: ${yamlQuote cfg.verify.issuer}\n        subject: ${yamlQuote cfg.verify.subjectRegex}"
  else "    secretRef:\n      name: platform-cosign";
  renderedOCI = pkgs.writeText "lifemodel-platform-ocirepository.yaml"
    (lib.replaceStrings
      [ "@PLATFORM_URL@" "@PLATFORM_INSECURE@" "@REF_BLOCK@" "@VERIFY_BLOCK@" ]
      [ cfg.platform.url (if cfg.platform.insecureRegistry then "true" else "false") refBlock verifyBlock ]
      (builtins.readFile (rootDir + "/ocirepository.yaml")));
  renderedKustomization = pkgs.writeText "lifemodel-platform-kustomization.yaml"
    (builtins.readFile (rootDir + "/kustomization.yaml"));
  fluxManifest = pkgs.fetchurl {
    url = "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml";
    hash = "sha256-nB/afkAUKVMe0UePZ7oGs+3/ZRO3XafuR73p8cTUJRw=";
  };
  kubectl = "${lifemodelK3s}/bin/k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml";
  lifemodelCli = pkgs.writeShellScriptBin "lifemodel" ''
    export LIFEMODEL_STATE_DIR=/var/lib/lifemodel
    export LIFEMODEL_CONFIGURED_REF=${lib.escapeShellArg platformRef}
    export LIFEMODEL_NIXOS=1
    exec ${pkgs.nodejs}/bin/node ${../cli/lifemodel.mjs} "$@"
  '';
  platformRef = if cfg.platform.digest != null then "digest=${cfg.platform.digest}" else "tag=${cfg.platform.tag}";
  keyFile = "/run/lifemodel/platform-cosign.pub";
  otherFlux = (config.services.fluxcd.enable or false) || (config.fluxcd.enable or false);
in
{
  options.services.lifemodel = {
    enable = mkEnableOption "lifemodel GitOps platform bootstrap";
    platform = {
      url = mkOption { type = types.str; description = "OCI URL of the signed platform artifact."; };
      tag = mkOption { type = types.nullOr types.str; default = null; description = "OCI artifact tag (required unless digest is set)."; };
      digest = mkOption { type = types.nullOr types.str; default = null; description = "Optional immutable OCI artifact digest."; };
      insecureRegistry = mkOption { type = types.bool; default = false; description = "Allow a VM-local plain HTTP OCI registry."; };
    };
    verify = {
      mode = mkOption { type = types.enum [ "keyless" "key" ]; default = "keyless"; };
      issuer = mkOption { type = types.str; default = "^https://token\\.actions\\.githubusercontent\\.com$"; };
      subjectRegex = mkOption {
        type = types.str;
        default = "^https://github\\.com/shady2k/lifemodel/\\.github/workflows/release\\.yml@refs/tags/v.*$";
      };
      publicKey = mkOption { type = types.nullOr types.str; default = null; description = "PEM public key used for cosign verification."; };
    };
    generatedRootOCI = mkOption { type = types.path; readOnly = true; internal = true; default = renderedOCI; };
    generatedRootKustomization = mkOption { type = types.path; readOnly = true; internal = true; default = renderedKustomization; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.platform.url != ""; message = "services.lifemodel.platform.url is required"; }
      { assertion = cfg.platform.digest != null || cfg.platform.tag != null;
        message = "services.lifemodel.platform.tag or services.lifemodel.platform.digest is required"; }
      { assertion = (cfg.platform.tag == null || !(lib.hasInfix "\n" cfg.platform.tag))
          && !(lib.hasInfix "\n" cfg.verify.issuer) && !(lib.hasInfix "\n" cfg.verify.subjectRegex);
        message = "platform tags and verification regexes must not contain newlines"; }
      { assertion = cfg.verify.mode != "key" || cfg.verify.publicKey != null;
        message = "services.lifemodel.verify.publicKey is required when verify.mode = key"; }
      { assertion = !otherFlux; message = "services.lifemodel cannot be enabled with another Flux installation"; }
      { assertion = toString config.services.k3s.package == toString lifemodelK3s;
        message = "services.k3s.package must be the pinned lifemodelK3s package"; }
    ];
    services.k3s = {
      enable = true;
      role = "server";
      clusterInit = true;
      package = lifemodelK3s;
    };
    environment.systemPackages = [ lifemodelK3s lifemodelCli ];
    systemd.services.lifemodel-flux-bootstrap = {
      description = "Install pinned Flux and lifemodel platform root objects";
      restartIfChanged = true;
      wantedBy = [ "multi-user.target" ];
      wants = [ "k3s.service" ];
      after = [ "k3s.service" ];
      requires = [ "k3s.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      path = [ pkgs.coreutils pkgs.gnugrep pkgs.util-linux lifemodelK3s lifemodelCli ];
      script = ''
        set -euo pipefail
        KUBECTL='${kubectl}'
        for attempt in $(seq 1 60); do
          if $KUBECTL get nodes >/dev/null 2>&1; then break; fi
          if [ "$attempt" -eq 60 ]; then echo 'k3s did not become ready' >&2; exit 1; fi
          sleep 2
        done
        if $KUBECTL get namespace flux-system >/dev/null 2>&1; then
          owner="$($KUBECTL get namespace flux-system -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
          if [ "$owner" != lifemodel ]; then
            echo 'Refusing to modify flux-system: namespace is not labelled as managed by lifemodel' >&2
            exit 1
          fi
        fi
        # Claim this namespace before Flux so an interrupted apply is resumable.
        # A dedicated field manager owns only the lifemodel marker.
        cat <<'EOF' | $KUBECTL apply --server-side --field-manager=lifemodel-namespace -f -
        apiVersion: v1
        kind: Namespace
        metadata:
          name: flux-system
          labels:
            app.kubernetes.io/managed-by: lifemodel
        EOF
        $KUBECTL apply --server-side -f ${fluxManifest}
        ${lib.optionalString (cfg.verify.mode == "key") ''
          install -d -m 0700 /run/lifemodel
          printf '%s\n' ${lib.escapeShellArg cfg.verify.publicKey} > ${keyFile}
          chmod 0600 ${keyFile}
          $KUBECTL create secret generic platform-cosign --namespace flux-system \
            --from-file=cosign.pub=${keyFile} --dry-run=client -o yaml | $KUBECTL apply --server-side -f -
        ''}
        install -d -m 0700 /var/lib/lifemodel
        exec 9>/var/lib/lifemodel/lock
        flock -x 9
        effectiveOCI=$(mktemp)
        trap 'rm -f "$effectiveOCI"' EXIT
        LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel render-ref ${renderedOCI} ${lib.escapeShellArg platformRef} > "$effectiveOCI"
        effectiveRef=$(LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel effective-ref ${lib.escapeShellArg platformRef})
        LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel assert-root-ownership
        $KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$effectiveOCI"
        $KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f ${renderedKustomization}
        LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel record-applied "$effectiveRef"
      '';
    };
  };
}

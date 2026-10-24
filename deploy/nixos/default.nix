{ config, lib, pkgs, lifemodelK3s, selfVersion, ... }:
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
  renderedInstance = pkgs.writeText "lifemodel-platform-instance.yaml"
    (builtins.replaceStrings [ ("$" + "{LIFEMODEL_NAME}") ] [ cfg.name ] (builtins.readFile (rootDir + "/instance.yaml")));
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
  # k3s takes the resolv.conf it is pointed at as given, and the kubelet hands it
  # to CoreDNS and to every pod. The host's own file cannot be used: one
  # link-local or loopback nameserver makes k3s drop the whole file and use
  # 8.8.8.8, which hides the LAN's resolver from the cluster
  # (lifemodel-s9v5.1.5). The shared script writes the file k3s reads, out of
  # the host's usable nameservers, and the path unit rewrites it when the host's
  # DNS changes.
  k3sResolvConf = "/run/lifemodel/k3s-resolv.conf";
  k3sResolvScript = ../k3s/k3s-resolv.sh;
  k3sResolvGenerator = ../k3s/resolv-conf.mjs;
  otherFlux = (config.services.fluxcd.enable or false) || (config.fluxcd.enable or false);
  publisher = pkgs.writeShellScriptBin "lifemodel-mdns-publish" (builtins.readFile ../mdns/publish-name);
  mdnsNames = [ "${cfg.name}.local" "boot-${cfg.name}.local" "vault-${cfg.name}.local" ];
  mdnsUnits = lib.listToAttrs (map (name: {
    name = "lifemodel-mdns-${lib.replaceStrings [ "." ] [ "-" ] name}";
    value = {
      description = "Publish ${name} on the LAN with mDNS";
      wantedBy = [ "multi-user.target" ];
      after = [ "avahi-daemon.service" "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [ pkgs.iproute2 pkgs.gawk pkgs.coreutils pkgs.bash pkgs.avahi ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${publisher}/bin/lifemodel-mdns-publish ${lib.escapeShellArg name} ${lib.escapeShellArg cfg.lanInterface}";
        Restart = "on-failure";
        RestartSec = 2;
        User = "avahi";
        Group = "avahi";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [ "AF_UNIX" "AF_NETLINK" ];
        RestrictNamespaces = true;
        LockPersonality = true;
      };
    };
  }) mdnsNames);
in
{
  options.services.lifemodel = {
    enable = mkEnableOption "lifemodel GitOps platform bootstrap";
    name = mkOption { type = types.strMatching "[a-z]([a-z0-9-]{0,55}[a-z0-9])?"; default = "lifemodel"; description = "Fixed non-reserved DNS-1035 instance label (max 57 characters)."; };
    lanInterface = mkOption { type = types.str; default = if (config.networking.defaultGateway.interface or null) == null then "" else config.networking.defaultGateway.interface; description = "LAN interface for mDNS publication and firewall access; set explicitly when no default gateway interface is declared."; };
    platform = {
      url = mkOption { type = types.str; default = "oci://ghcr.io/shady2k/lifemodel-platform"; description = "OCI URL of the signed platform artifact."; };
      tag = mkOption { type = types.nullOr types.str; default = selfVersion; description = "OCI artifact tag; defaults to the flake release version."; };
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
    generatedRootInstance = mkOption { type = types.path; readOnly = true; internal = true; default = renderedInstance; };
    generatedRootOCI = mkOption { type = types.path; readOnly = true; internal = true; default = renderedOCI; };
    generatedRootKustomization = mkOption { type = types.path; readOnly = true; internal = true; default = renderedKustomization; };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = cfg.platform.url != ""; message = "services.lifemodel.platform.url is required"; }
      { assertion = cfg.lanInterface != ""; message = "set networking.defaultGateway.interface or services.lifemodel.lanInterface to choose the LAN interface"; }
      { assertion = builtins.stringLength cfg.lanInterface <= 15 && builtins.match "[A-Za-z0-9_.:-]+" cfg.lanInterface != null; message = "services.lifemodel.lanInterface must be a valid Linux interface name (1-15 safe characters)"; }
      { assertion = !(lib.any (prefix: lib.hasPrefix prefix cfg.lanInterface) [ "cni" "flannel" "veth" "wg" "tun" "tailscale" ]);
        message = "services.lifemodel.lanInterface must be a LAN interface, not a cluster, tunnel or VPN interface"; }
      { assertion = builtins.stringLength cfg.name <= 57
          && !(builtins.elem (lib.toLower cfg.name) [ "y" "n" "yes" "no" "true" "false" "on" "off" "null" "~" ]);
        message = "services.lifemodel.name must be a non-reserved DNS-1035 label of at most 57 characters"; }
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
      extraFlags = [ "--resolv-conf ${k3sResolvConf}" ];
    };
    # The canonical image authority is identical in the loader, Jobs and
    # containerd. Host DNS is not involved: kube-proxy routes this fixed Service
    # IP on the sole node. There is no hostPort or external registry listener.
    environment.etc."rancher/k3s/registries.yaml".text = ''
      mirrors:
        "zot.lifemodel-system.svc:5001":
          endpoint:
            - "http://10.43.0.51:5001"
    '';
    environment.etc."rancher/k3s/config.yaml.d/lifemodel-registry.yaml".text = ''
      disable-default-registry-endpoint: true
      service-cidr: 10.43.0.0/16
    '';
    environment.systemPackages = [ lifemodelK3s lifemodelCli publisher ];
    services.avahi = {
      enable = true;
      publish.enable = true;
      publish.userServices = true;
      openFirewall = false;
      allowInterfaces = [ cfg.lanInterface ];
    };
    networking.firewall.interfaces.${cfg.lanInterface} = {
      allowedTCPPorts = [ 80 443 ];
      allowedUDPPorts = [ 5353 ];
    };
    systemd.paths."lifemodel-k3s-resolv" = {
      wantedBy = [ "multi-user.target" ];
      pathConfig = {
        # Both sources the service reads: a host with systemd-resolved puts its
        # real upstream servers in the second one and leaves the stub at 127.0.0.53.
        PathChanged = [ "/etc/resolv.conf" "/run/systemd/resolve/resolv.conf" ];
        Unit = "lifemodel-k3s-resolv.service";
      };
    };
    systemd.services = mdnsUnits // {
    lifemodel-k3s-resolv = {
      description = "Write the resolv.conf k3s gives the kubelet and CoreDNS";
      wantedBy = [ "multi-user.target" ];
      before = [ "k3s.service" ];
      path = [ pkgs.nodejs pkgs.coreutils pkgs.systemd pkgs.util-linux ];
      unitConfig.StartLimitIntervalSec = 0;
      # No RemainAfterExit: the path unit starts this unit again on every change,
      # and starting an already-active unit would do nothing.
      serviceConfig = { Type = "oneshot"; TimeoutStartSec = 30; };
      script = "exec ${k3sResolvScript} ${k3sResolvGenerator} ${k3sResolvConf} /etc/resolv.conf /run/systemd/resolve/resolv.conf";
    };
    k3s = {
      requires = [ "lifemodel-k3s-resolv.service" ];
      after = [ "lifemodel-k3s-resolv.service" ];
      serviceConfig.ExecStartPre = "${pkgs.coreutils}/bin/test -s ${k3sResolvConf}";
    };
    lifemodel-k3s-dns-apply = {
      description = "Reconcile CoreDNS with the desired host resolver";
      wantedBy = [ "multi-user.target" ];
      after = [ "k3s.service" ];
      path = [ pkgs.nodejs pkgs.coreutils pkgs.util-linux lifemodelK3s ];
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        TimeoutStartSec = 180;
        Restart = "on-failure";
        RestartSec = 30;
      };
      script = "exec ${../k3s/k3s-dns-apply.sh} ${k3sResolvConf} ${k3sResolvGenerator} /etc/resolv.conf /run/systemd/resolve/resolv.conf";
    };
    lifemodel-flux-bootstrap = {
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
      path = [ pkgs.coreutils pkgs.gnugrep pkgs.util-linux pkgs.nodejs pkgs.curl lifemodelK3s lifemodelCli ];
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
        if [ -f /var/lib/lifemodel/instance-name ]; then
          installed_name="$(cat /var/lib/lifemodel/instance-name)"
          [ -n "$installed_name" ] || { echo 'saved lifemodel instance name is empty' >&2; exit 1; }
        else
          identity_error=$(mktemp)
          if installed_name=$($KUBECTL -n flux-system get configmap lifemodel-instance -o jsonpath='{.data.LIFEMODEL_NAME}' 2>"$identity_error"); then
            [ -n "$installed_name" ] || { rm -f "$identity_error"; echo 'existing lifemodel-instance ConfigMap has no LIFEMODEL_NAME' >&2; exit 1; }
          else
            if grep -Fqi '(NotFound)' "$identity_error"; then installed_name="";
            else cat "$identity_error" >&2; rm -f "$identity_error"; echo 'cannot determine existing instance identity' >&2; exit 1; fi
          fi
          rm -f "$identity_error"
        fi
        if [ -n "$installed_name" ] && [ "$installed_name" != ${lib.escapeShellArg cfg.name} ]; then
          echo 'lifemodel instance name is fixed after install' >&2; exit 1
        fi
        printf '%s\n' ${lib.escapeShellArg cfg.name} > /var/lib/lifemodel/instance-name.tmp
        chmod 0600 /var/lib/lifemodel/instance-name.tmp
        mv /var/lib/lifemodel/instance-name.tmp /var/lib/lifemodel/instance-name
        $KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$effectiveOCI"
        $KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f ${renderedInstance}
        $KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f ${renderedKustomization}
        LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel record-applied "$effectiveRef"
        # Readiness is CA-verified before logging an address the owner can use.
        LIFEMODEL_NAME=${lib.escapeShellArg cfg.name} LIFEMODEL_KUBECTL="$KUBECTL" \
          node ${../cli/wait-ready.mjs}
        LIFEMODEL_LOCK_FD=9 LIFEMODEL_LOCK_HELD=1 lifemodel address
      '';
    };
    };
  };
}

{
  description = "lifemodel NixOS platform bootstrap module";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = nixpkgs.lib;
      keylessIssuer = "^https://token\\.actions\\.githubusercontent\\.com$";
      keylessSubject = "^https://github\\.com/shady2k/lifemodel/\\.github/workflows/release\\.yml@refs/tags/v.*$";
      releaseWorkflow = builtins.readFile ./.github/workflows/release.yml;
      module = ./deploy/nixos;
      exportedModule = { pkgs, ... }:
        let lockedK3s = nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.k3s;
        in {
          imports = [ module ];
          _module.args.selfVersion = lib.removeSuffix "\n" (builtins.readFile ./deploy/nixos/release-tag);
          _module.args.lifemodelK3s = lockedK3s;
        };
      baseModule = { ... }: {
        system.stateVersion = "26.05";
        fileSystems."/" = { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; };
        boot.loader.grub.devices = [ "nodev" ];
        services.lifemodel = {
          enable = true;
          platform.url = "oci://ghcr.io/shady2k/lifemodel-platform";
          platform.tag = "v1.0.0";
          lanInterface = "eth0";
        };
      };
      evaluate = extra: lib.nixosSystem { inherit system; modules = [ exportedModule baseModule extra ]; };
      keyless = evaluate {};
      verifyKey = "-----BEGIN PUBLIC KEY-----\nZm9v\n-----END PUBLIC KEY-----";
      keyMode = evaluate ({ ... }: {
        services.lifemodel.verify = {
          mode = "key";
          publicKey = verifyKey;
        };
      });
      missingKey = evaluate ({ ... }: { services.lifemodel.verify.mode = "key"; });
      missingKeyFails = !(builtins.tryEval missingKey.config.system.build.toplevel.drvPath).success;
      badInstanceName = evaluate ({ ... }: { services.lifemodel.name = "Bad"; });
      tooLongInstanceName = evaluate ({ ... }: { services.lifemodel.name = "x" + builtins.concatStringsSep "" (builtins.genList (_: "x") 57); });
      yamlReservedNames = map (name: evaluate ({ ... }: { services.lifemodel.name = name; })) [ "true" "null" "123" "1abc" "y" "n" "yes" "no" "false" "on" "off" "~" ];
      yamlReservedNamesFail = builtins.all (evaluated: !(builtins.tryEval evaluated.config.system.build.toplevel.drvPath).success) yamlReservedNames;
      yamlReservedNamesCheck = assert yamlReservedNamesFail; pkgs.runCommand "lifemodel-yaml-reserved-instance-names-rejected" {} "touch $out";
      badInstanceNameFails = !(builtins.tryEval badInstanceName.config.system.build.toplevel.drvPath).success;
      tooLongInstanceNameFails = !(builtins.tryEval tooLongInstanceName.config.system.build.toplevel.drvPath).success;
      keylessOCI = builtins.readFile keyless.config.services.lifemodel.generatedRootOCI;
      keyOCI = builtins.readFile keyMode.config.services.lifemodel.generatedRootOCI;
      scriptKeylessOCI = builtins.readFile (scriptKeyless + "/ocirepository.yaml");
      scriptKeyOCI = builtins.readFile (scriptKey + "/ocirepository.yaml");
      scriptKustomization = builtins.readFile (scriptKeyless + "/kustomization.yaml");
      # The generic-Linux installer (scripts/install.sh) renders the same
      # objects from the same templates: compare its render-only output with
      # the module's byte for byte (the check the suite cannot reach - the
      # heavy vitest boundary builds a Node container, not a Nix one).
      platformUrl = "oci://ghcr.io/shady2k/lifemodel-platform";
      renderOnly = mode: url: tag: extraArgs:
        pkgs.runCommand "lifemodel-install-sh-render-${mode}-${tag}" { nativeBuildInputs = [ pkgs.busybox ]; } ''
          mkdir -p $out $TMPDIR/work/scripts $TMPDIR/work/deploy/mdns
          cp -r ${./deploy/mdns}/. $TMPDIR/work/deploy/mdns/
          cp ${./scripts/install.sh} $TMPDIR/work/scripts/install.sh
          cp -r ${./deploy/root} $TMPDIR/work/deploy/root
          busybox sh $TMPDIR/work/scripts/install.sh --platform-url ${url} --tag ${lib.escapeShellArg tag} \
            --verify ${mode} --lan-interface eth0 ${lib.optionalString (mode == "key") "--public-key-file ${pkgs.writeText "platform-cosign.pub" verifyKey}"} \
            --render-only $out ${extraArgs}
        '';
      scriptKeyless = renderOnly "keyless" platformUrl "v1.0.0" "";
      scriptKey = renderOnly "key" platformUrl "v1.0.0" "";
      mdnsRendered = renderOnly "keyless" platformUrl "v1.0.0" "--lan-interface eth0";
      mdnsInstallerUnits = pkgs.runCommand "lifemodel-mdns-installer-unit-render" { nativeBuildInputs = [ pkgs.gnugrep pkgs.diffutils ]; } ''
        set -eu
        for name in lifemodel.local boot-lifemodel.local vault-lifemodel.local; do
          unit=$(printf '%s' "$name" | sed 's/\./-/g')
          file=${mdnsRendered}/systemd/lifemodel-mdns-$unit.service
          grep -F "Description=Publish $name on LAN with mDNS" "$file"
          grep -F "ExecStart=/usr/lib/lifemodel/publish-name $name eth0" "$file"
          grep -F 'Restart=on-failure' "$file"
          grep -F 'NoNewPrivileges=true' "$file"
          grep -F 'ProtectSystem=strict' "$file"
          grep -F 'RestrictAddressFamilies=AF_UNIX AF_NETLINK' "$file"
        done
        touch $out
      '';
      customTag = "20261013";
      customIssuer = ''^issuer\.path/'quoted"$'';
      customSubject = ''^subject\\literal/'quote"$'';
      customVerify = evaluate ({ ... }: {
        services.lifemodel.platform.tag = lib.mkForce customTag;
        services.lifemodel.verify.issuer = customIssuer;
        services.lifemodel.verify.subjectRegex = customSubject;
      });
      customScript = renderOnly "keyless" platformUrl customTag
        "--issuer ${lib.escapeShellArg customIssuer} --subject-regex ${lib.escapeShellArg customSubject}";
      customOCI = builtins.readFile customVerify.config.services.lifemodel.generatedRootOCI;
      missingKeyFile = pkgs.runCommand "lifemodel-install-sh-key-requires-key-file" { nativeBuildInputs = [ pkgs.busybox ]; } ''
        mkdir -p $TMPDIR/work/scripts $TMPDIR/work/deploy
        cp ${./scripts/install.sh} $TMPDIR/work/scripts/install.sh
        cp -r ${./deploy/root} $TMPDIR/work/deploy/root
        if output=$(busybox sh $TMPDIR/work/scripts/install.sh \
          --platform-url ${platformUrl} --tag v1.0.0 --verify key --render-only $TMPDIR/out 2>&1); then
          echo "installer accepted key mode without --public-key-file" >&2
          exit 1
        fi
        printf '%s\n' "$output" | busybox grep -F -- "--public-key-file is required when --verify key"
        touch $out
      '';
      compare = name: actual: fixture: pkgs.runCommand name {} ''
        printf %s ${lib.escapeShellArg actual} > actual.yaml
        diff -u ${fixture} actual.yaml
        touch $out
      '';
      keylessIdentityAgreement =
        assert keyless.config.services.lifemodel.verify.issuer == keylessIssuer;
        assert keyless.config.services.lifemodel.verify.subjectRegex == keylessSubject;
        assert lib.hasInfix "--certificate-oidc-issuer-regexp '${keylessIssuer}'" releaseWorkflow;
        assert lib.hasInfix "--certificate-identity-regexp '${keylessSubject}'" releaseWorkflow;
        pkgs.runCommand "lifemodel-keyless-identity-agreement" {} "touch $out";
      installScript = builtins.readFile ./scripts/install.sh;
      installK3sVersionLine = lib.findFirst (line: lib.hasPrefix "K3S_VERSION=" line) "" (lib.splitString "\n" installScript);
      installK3sVersion = builtins.elemAt (builtins.match "K3S_VERSION=\"([^\"]+)\"" installK3sVersionLine) 0;
      forcedConsumerOverride = evaluate ({ ... }: {
        services.k3s.package = lib.mkForce pkgs.hello;
      });
      forcedConsumerOverrideFails = !(builtins.tryEval forcedConsumerOverride.config.system.build.toplevel.drvPath).success;
      renderedPlatform = pkgs.runCommand "lifemodel-platform-kustomize-wiring" {
        nativeBuildInputs = [ pkgs.kustomize pkgs.gnugrep pkgs.coreutils (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) ];
      } ''
        set -eu
        # Flux first applies the parent source, then reconciles its ./a0 path.
        kustomize build ${./deploy/platform} > parent.yaml
        grep -F 'kind: Kustomization' parent.yaml >/dev/null
        grep -F 'name: platform-instance' parent.yaml >/dev/null
        grep -F 'name: platform-a0' parent.yaml >/dev/null
        grep -F 'name: platform-instance' ${./deploy/platform/a0-reconciler.yaml} >/dev/null
        grep -F 'optional: false' ${./deploy/platform/instance-reconciler.yaml} >/dev/null
        kustomize build ${./deploy/platform/instance} > instance.yaml
        for name in lifemodel home a0; do
          python -c 'import sys; s=open(sys.argv[1]).read(); open(sys.argv[2], "w").write(s.replace(chr(36)+"{LIFEMODEL_NAME}", sys.argv[3]))' instance.yaml "instance-$name.yaml" "$name"
          grep -F "LIFEMODEL_NAME: $name" "instance-$name.yaml" >/dev/null
          python -c 'import yaml,sys; docs=list(yaml.safe_load_all(open(sys.argv[1]))); assert all(type(d["data"]["LIFEMODEL_NAME"]) is str and d["data"]["LIFEMODEL_NAME"] == sys.argv[2] for d in docs if d.get("kind") == "ConfigMap")' "instance-$name.yaml" "$name"
        done
        placeholder=$(printf '$%s' '{LIFEMODEL_NAME}')
        for name in lifemodel home a0; do
          if grep -F "$placeholder" "instance-$name.yaml" >/dev/null; then
            echo 'instance post-build output retains LIFEMODEL_NAME placeholder' >&2; exit 1
          fi
        done
        grep -F 'name: lifemodel-system' instance.yaml >/dev/null
        grep -F 'name: lifemodel' instance.yaml >/dev/null
        grep -F 'boot-' instance.yaml >/dev/null
        kustomize build ${./deploy/platform/a0} > a0.yaml
        validate_a0() {
          for kind in ServiceAccount PersistentVolumeClaim Deployment Service NetworkPolicy; do
            grep -F "kind: $kind" "$1" >/dev/null || return 1
          done
          grep -E 'image: ghcr.io/shady2k/lifemodel-loader@sha256:[a-f0-9]{64}' "$1" >/dev/null
        }
        validate_a0 a0.yaml
        cp -r ${./deploy/platform/a0} missing-resource
        chmod -R u+w missing-resource
        sed '/- deployment.yaml/d' missing-resource/kustomization.yaml > missing-resource/kustomization.tmp
        mv missing-resource/kustomization.tmp missing-resource/kustomization.yaml
        kustomize build missing-resource > missing-resource.yaml
        if validate_a0 missing-resource.yaml; then
          echo 'A0 resource validation accepted a missing deployment reference' >&2
          exit 1
        fi
        touch $out
      '';
      renderedOpenBao = pkgs.runCommand "lifemodel-openbao-platform-render" {
        nativeBuildInputs = [ pkgs.kubernetes-helm pkgs.kustomize pkgs.gnugrep pkgs.coreutils pkgs.diffutils ];
      } ''
        set -eux
        helm template openbao ${./deploy/platform/charts/openbao} --namespace openbao \
          --skip-tests -f ${./deploy/platform/a/openbao-values.yaml} > openbao-generated.yaml
        cmp openbao-generated.yaml ${./deploy/platform/a/openbao/rendered.yaml}
        grep -F 'kind: StatefulSet' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'volumeClaimTemplates:' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'storage "raft"' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'serviceAccountName: openbao' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'persistentVolumeClaimRetentionPolicy:' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'whenDeleted: Retain' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -F 'whenScaled: Retain' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null
        grep -A2 -F 'capabilities:' ${./deploy/platform/a/openbao/rendered.yaml} | grep -F -- '- ALL' >/dev/null
        if grep -F 'automountServiceAccountToken: false' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null; then
          echo 'OpenBao pod disables its ServiceAccount token mount' >&2; exit 1
        fi
        grep -F 'pod-security.kubernetes.io/enforce: restricted' ${./deploy/platform/a/namespace.yaml} >/dev/null
        if grep -E 'kind: (Deployment|MutatingWebhookConfiguration)|seal "' ${./deploy/platform/a/openbao/rendered.yaml} >/dev/null; then
          echo 'OpenBao injector or auto-unseal rendered unexpectedly' >&2; exit 1
        fi
        kustomize build ${./deploy/platform} > platform.yaml
        grep -F 'name: platform-a' platform.yaml >/dev/null
        grep -F 'name: platform-a0' platform.yaml >/dev/null
        kustomize build ${./deploy/platform/a} > step-a.yaml
        if grep -F 'kind: HelmRelease' step-a.yaml >/dev/null; then
          echo 'step A must not contain HelmRelease objects' >&2
          exit 1
        fi
        grep -F 'name: openbao-default-deny' step-a.yaml >/dev/null
        grep -F 'name: openbao-server-access' step-a.yaml >/dev/null
        grep -F 'kind: NetworkPolicy' step-a.yaml >/dev/null
        grep -F 'kind: Namespace' step-a.yaml >/dev/null
        grep -F 'kustomize.toolkit.fluxcd.io/prune: disabled' step-a.yaml >/dev/null
        grep -F 'kind: ClusterRoleBinding' step-a.yaml >/dev/null
        grep -F 'name: system:auth-delegator' step-a.yaml >/dev/null
        grep -F 'name: platform-a0' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        grep -F 'wait: true' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        grep -F 'timeout: 10m0s' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        touch $out
      '';
      renderedCNPG = pkgs.runCommand "lifemodel-cnpg-platform-render" {
        nativeBuildInputs = [ pkgs.kubernetes-helm pkgs.kustomize pkgs.gnugrep pkgs.coreutils pkgs.diffutils (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) ];
      } ''
        set -eux
        helm template cloudnative-pg ${./deploy/platform/charts/cloudnative-pg} \
          --namespace cnpg-system --include-crds -f ${./deploy/platform/b/operator-values.yaml} > cnpg-generated.yaml
        cmp cnpg-generated.yaml ${./deploy/platform/b/operator/rendered.yaml}
        grep -F 'kind: CustomResourceDefinition' ${./deploy/platform/b/operator/rendered.yaml} >/dev/null
        grep -F 'name: clusters.postgresql.cnpg.io' ${./deploy/platform/b/operator/rendered.yaml} >/dev/null
        grep -F 'image: "ghcr.io/cloudnative-pg/cloudnative-pg@sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07"' ${./deploy/platform/b/operator/rendered.yaml} >/dev/null
        kustomize build ${./deploy/platform/b} > cnpg-operator.yaml
        kustomize build ${./deploy/platform/state} > state.yaml
        kustomize build ${./deploy/platform/a} > step-a.yaml
        kustomize build ${./deploy/platform} > parent.yaml
        kustomize build ${./deploy/platform/a0} > a0.yaml
        python ${./scripts/check-platform-crd-schemas.py} ${./deploy/platform/b/operator/rendered.yaml} \
          cnpg-operator.yaml parent.yaml a0.yaml step-a.yaml state.yaml
        cp -r ${./deploy/platform/state} planted-state
        chmod -R u+w planted-state
        sed '/^  instances:/a\  plantedUnknownField: true' planted-state/cluster/cluster.yaml > planted-state/cluster/cluster.tmp
        mv planted-state/cluster/cluster.tmp planted-state/cluster/cluster.yaml
        kustomize build planted-state > planted-state.yaml
        if python ${./scripts/check-platform-crd-schemas.py} ${./deploy/platform/b/operator/rendered.yaml} planted-state.yaml; then
          echo 'vendored CRD schema check accepted a planted unknown Cluster field' >&2
          exit 1
        fi
        cp -r ${./deploy/platform/state} planted-scalar
        chmod -R u+w planted-scalar
        sed 's/^  instances: 1$/  instances: not-an-integer/' planted-scalar/cluster/cluster.yaml > planted-scalar/cluster/cluster.tmp
        mv planted-scalar/cluster/cluster.tmp planted-scalar/cluster/cluster.yaml
        kustomize build planted-scalar > planted-scalar.yaml
        if python ${./scripts/check-platform-crd-schemas.py} ${./deploy/platform/b/operator/rendered.yaml} planted-scalar.yaml; then
          echo 'vendored CRD schema check accepted a scalar with the wrong type' >&2
          exit 1
        fi
        grep -F 'name: lifemodel-state' state.yaml >/dev/null
        grep -F 'name: lifemodel-postgres-egress' step-a.yaml >/dev/null
        grep -A25 -F 'name: lifemodel-dns-egress' step-a.yaml | grep -F 'k8s-app: kube-dns' >/dev/null
        grep -A25 -F 'name: lifemodel-dns-egress' step-a.yaml | grep -F 'port: 53' >/dev/null
        grep -F 'name: lifemodel-state-postgres-access' state.yaml >/dev/null
        grep -F 'cnpg.io/cluster: lifemodel' state.yaml >/dev/null
        grep -F 'port: 6443' state.yaml >/dev/null
        grep -F 'imageName: ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:fe22b9fcd038dcd08c2019b17d95f517f137801e5f39d857a895d65e8c63033b' ${./deploy/platform/state/cluster/cluster.yaml} >/dev/null
        grep -F 'name: platform-b' ${./deploy/platform/b-reconciler.yaml} >/dev/null
        grep -F 'name: platform-c' ${./deploy/platform/c-reconciler.yaml} >/dev/null
        grep -F 'name: platform-a' ${./deploy/platform/b-reconciler.yaml} >/dev/null
        grep -F 'name: platform-b' ${./deploy/platform/c-reconciler.yaml} >/dev/null
        touch $out
      '';
      renderedGitea = pkgs.runCommand "lifemodel-gitea-platform-render" {
        nativeBuildInputs = [ pkgs.kubernetes-helm pkgs.kustomize pkgs.gnugrep pkgs.coreutils pkgs.diffutils ];
      } ''
        set -eux
        helm template gitea ${./deploy/platform/charts/gitea} --namespace lifemodel-git \
          --skip-tests -f ${./deploy/platform/a/gitea/values.yaml} > gitea-generated.yaml
        cmp gitea-generated.yaml ${./deploy/platform/a/gitea/rendered.yaml}
        grep -F 'DB_TYPE=sqlite3' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'PATH=/data/gitea/gitea.db' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'ROOT=/data/git/repositories' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'mountPath: /data' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'runAsNonRoot: true' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'allowPrivilegeEscalation: false' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'seccompProfile:' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F -- '- ALL' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'name: gitea-admin' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -E 'key:[[:space:]]+username' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -E 'key:[[:space:]]+password' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        grep -F 'claimName: gitea-shared-storage' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        test "$(grep -F -c 'kind: PersistentVolumeClaim' ${./deploy/platform/a/gitea/rendered.yaml})" -eq 1
        if grep -F 'kind: Ingress' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null; then
          echo 'Gitea Ingress must not be rendered in step A' >&2; exit 1
        fi
        grep -F 'kustomize.toolkit.fluxcd.io/prune: disabled' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null
        if grep -Ei '^  name: [^ ]*(postgresql|valkey)|^kind: StatefulSet$' ${./deploy/platform/a/gitea/rendered.yaml} >/dev/null; then
          echo 'Gitea rendered a bundled PostgreSQL or Valkey workload' >&2
          exit 1
        fi
        kustomize build ${./deploy/platform/a/gitea} > gitea-platform.yaml
        grep -F 'name: gitea-default-deny' gitea-platform.yaml >/dev/null
        if grep -F 'kind: HelmRelease' gitea-platform.yaml >/dev/null; then
          echo 'Gitea component must not contain HelmRelease objects' >&2
          exit 1
        fi
        grep -F 'kubernetes.io/metadata.name: lifemodel-system' gitea-platform.yaml >/dev/null
        grep -F 'kubernetes.io/metadata.name: flux-system' gitea-platform.yaml >/dev/null
        if grep -F 'kubernetes.io/metadata.name: kube-system' gitea-platform.yaml >/dev/null; then
          echo 'Gitea policy must not allow Traefik ingress' >&2; exit 1
        fi
        grep -F 'egress: []' gitea-platform.yaml >/dev/null
        touch $out
      '';
      cliHelp = pkgs.runCommand "lifemodel-cli-help" { nativeBuildInputs = [ pkgs.nodejs pkgs.gnugrep ]; } ''
        node ${./deploy/cli/lifemodel.mjs} --help > help.txt
        grep -F 'Usage: lifemodel doctor' help.txt > /dev/null
        grep -F -- '--repin previous' help.txt > /dev/null
        touch $out
      '';
      bootstrapScript = keyless.config.systemd.services.lifemodel-flux-bootstrap.script;
      changedTag = evaluate ({ ... }: {
        services.lifemodel.platform.tag = lib.mkForce "v1.0.1";
      });
      bootstrapExecStart = keyless.config.systemd.services.lifemodel-flux-bootstrap.serviceConfig.ExecStart;
      changedBootstrapExecStart = changedTag.config.systemd.services.lifemodel-flux-bootstrap.serviceConfig.ExecStart;
      bootstrapActivationCheck =
        assert !(builtins.hasAttr "lifemodel-bootstrap" keyless.config.system.activationScripts);
        assert bootstrapExecStart != changedBootstrapExecStart;
        pkgs.runCommand "lifemodel-bootstrap-unit-restart" {} "touch $out";
      bootstrapOwnership =
        assert lib.hasInfix ''$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$effectiveOCI"'' bootstrapScript;
        assert lib.hasInfix
          (builtins.unsafeDiscardStringContext ''$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f ${toString keyless.config.services.lifemodel.generatedRootKustomization}'')
          bootstrapScript;
        assert !(lib.hasInfix "--force-conflicts" bootstrapScript);
        assert lib.hasInfix "$KUBECTL apply --server-side --field-manager=lifemodel-namespace -f -" bootstrapScript;
        assert lib.hasInfix ''$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$effective_oci"'' installScript;
        assert lib.hasInfix ''$KUBECTL apply --server-side --field-manager=lifemodel-bootstrap -f "$render_dir/kustomization.yaml"'' installScript;
        assert !(lib.hasInfix "--force-conflicts" installScript);
        pkgs.runCommand "lifemodel-bootstrap-field-ownership" {} "touch $out";
      avahiConfigPath = builtins.elemAt (lib.splitString " " (builtins.elemAt (lib.splitString " -f " keyless.config.systemd.services.avahi-daemon.serviceConfig.ExecStart) 1)) 0;
      renderedAvahiConfig = builtins.readFile avahiConfigPath;
      mdnsEvaluation =
        let names = [ "lifemodel.local" "boot-lifemodel.local" "vault-lifemodel.local" ];
            units = keyless.config.systemd.services;
        in assert keyless.config.services.avahi.enable;
           assert keyless.config.services.avahi.publish.enable;
           assert keyless.config.services.avahi.publish.userServices;
           assert lib.hasInfix "disable-publishing=no" renderedAvahiConfig;
           assert lib.hasInfix "disable-user-service-publishing=no" renderedAvahiConfig;
           assert lib.hasInfix "allow-interfaces=eth0" renderedAvahiConfig;
           assert keyless.config.services.avahi.openFirewall == false;
           assert !(builtins.elem 5353 keyless.config.networking.firewall.allowedUDPPorts);
           assert !(builtins.elem 80 keyless.config.networking.firewall.allowedTCPPorts);
           assert !(builtins.elem 443 keyless.config.networking.firewall.allowedTCPPorts);
           assert keyless.config.services.avahi.allowInterfaces == [ keyless.config.services.lifemodel.lanInterface ];
           assert keyless.config.networking.firewall.interfaces.${keyless.config.services.lifemodel.lanInterface}.allowedTCPPorts == [ 80 443 ];
           assert keyless.config.networking.firewall.interfaces.${keyless.config.services.lifemodel.lanInterface}.allowedUDPPorts == [ 5353 ];
           assert keyless.config.services.avahi.publish.enable;
           assert keyless.config.services.avahi.publish.userServices;
           assert keyless.config.systemd.services."lifemodel-mdns-lifemodel-local".serviceConfig.NoNewPrivileges;
           assert keyless.config.systemd.services."lifemodel-mdns-lifemodel-local".serviceConfig.RestrictAddressFamilies == [ "AF_UNIX" "AF_NETLINK" ];

           assert builtins.all (name: builtins.hasAttr "lifemodel-mdns-${lib.replaceStrings [ "." ] [ "-" ] name}" units) names;
           assert builtins.all (name: lib.hasInfix "${name}" units."lifemodel-mdns-${lib.replaceStrings [ "." ] [ "-" ] name}".serviceConfig.ExecStart) names;
           assert !(lib.hasInfix "publish-workstation" (builtins.toJSON keyless.config.services.avahi));
           pkgs.runCommand "lifemodel-mdns-module-evaluation" {} "touch $out";
      releaseDefaults = lib.nixosSystem {
        inherit system;
        modules = [ exportedModule ({ ... }: {
          system.stateVersion = "26.05";
          fileSystems."/" = { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; };
          boot.loader.grub.devices = [ "nodev" ];
          services.lifemodel.enable = true;
          services.lifemodel.lanInterface = "eth0";
        }) ];
      };
      releaseTag = lib.removeSuffix "\n" (builtins.readFile ./deploy/nixos/release-tag);
      releaseDefaultsCheck =
        assert releaseDefaults.config.services.lifemodel.platform.url == platformUrl;
        assert releaseDefaults.config.services.lifemodel.platform.tag == releaseTag;
        assert releaseDefaults.config.services.lifemodel.platform.digest == null;
        assert lib.hasInfix "tag: '${releaseTag}'" (builtins.readFile releaseDefaults.config.services.lifemodel.generatedRootOCI);
        assert builtins.match "v[0-9][A-Za-z0-9._-]*" releaseTag != null;
        pkgs.runCommand "lifemodel-flake-own-release-default" {} "touch $out";
      bootstrapWaitCheck =
        assert lib.hasInfix "wait-ready.mjs" bootstrapScript;
        assert !(lib.hasInfix "lifemodel address ||" bootstrapScript);
        assert builtins.elem pkgs.nodejs keyless.config.systemd.services.lifemodel-flux-bootstrap.path;
        assert builtins.elem pkgs.curl keyless.config.systemd.services.lifemodel-flux-bootstrap.path;
        pkgs.runCommand "lifemodel-bootstrap-verified-address" {
          nativeBuildInputs = [ pkgs.bash pkgs.coreutils pkgs.gnugrep pkgs.util-linux ];
        } ''
          set -eu
          mkdir bin state
          export BOOTSTRAP_LOG="$PWD/bootstrap.log"
          export BOOTSTRAP_STATE="$PWD/state"
          export BOOTSTRAP_WAIT_EXIT=0
          cat > bin/kubectl <<'EOF'
          #!${pkgs.runtimeShell}
          case "$*" in
            'get nodes') exit 0 ;;
            'get namespace flux-system') exit 1 ;;
            *'get configmap lifemodel-instance'*) echo '(NotFound)' >&2; exit 1 ;;
            *' -f -') cat >/dev/null ;;
            *'apply '*) : ;;
            *) echo "unexpected kubectl call: $*" >&2; exit 1 ;;
          esac
          EOF
          cat > bin/lifemodel <<'EOF'
          #!${pkgs.runtimeShell}
          case "$1" in
            render-ref) printf '%s\n' rendered-root ;;
            effective-ref) echo "$2" ;;
            assert-root-ownership) : ;;
            record-applied) echo applied >> "$BOOTSTRAP_LOG" ;;
            address) echo address >> "$BOOTSTRAP_LOG" ;;
            *) exit 1 ;;
          esac
          EOF
          cat > bin/node <<'EOF'
          #!${pkgs.runtimeShell}
          case "$1" in *wait-ready.mjs) ;; *) exit 1 ;; esac
          [ "$LIFEMODEL_NAME" = lifemodel ] || exit 1
          [ "$LIFEMODEL_KUBECTL" = "$PWD/bin/kubectl" ] || exit 1
          echo wait >> "$BOOTSTRAP_LOG"
          exit "$BOOTSTRAP_WAIT_EXIT"
          EOF
          chmod +x bin/*
          export PATH="$PWD/bin:$PATH"
          cp ${pkgs.writeText "bootstrap-test.sh" (builtins.unsafeDiscardStringContext (builtins.replaceStrings
            [ kubectlPlaceholder "/var/lib/lifemodel" ]
            [ "__TEST_KUBECTL__" "__TEST_STATE__" ] bootstrapScript))} bootstrap.in
          sed -e "s|__TEST_KUBECTL__|$PWD/bin/kubectl|g" \
              -e "s|__TEST_STATE__|$PWD/state|g" bootstrap.in > bootstrap.sh
          bash bootstrap.sh
          printf 'applied\nwait\naddress\n' > expected
          cmp expected "$BOOTSTRAP_LOG"
          : > "$BOOTSTRAP_LOG"
          export BOOTSTRAP_WAIT_EXIT=7
          if bash bootstrap.sh; then
            echo 'bootstrap ignored failed verified readiness' >&2; exit 1
          fi
          printf 'applied\nwait\n' > expected
          cmp expected "$BOOTSTRAP_LOG"
          touch $out
        '';
      kubectlPlaceholder = "${keyless.config.services.k3s.package}/bin/k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml";
      moduleEvaluation = assert toString keyless.config.services.k3s.package
          == toString nixpkgs.legacyPackages.${system}.k3s;
        assert keyless.config.services.k3s.package.version == pkgs.k3s.version;
        assert keyless.config.services.k3s.package.version == installK3sVersion;
        assert customVerify.config.services.lifemodel.platform.tag == customTag;
        assert forcedConsumerOverrideFails;
        assert keyless.config.services.k3s.enable;
        assert keyless.config.system.build.toplevel.drvPath != "";
        assert keyMode.config.services.lifemodel.verify.mode == "key";
        assert keyMode.config.system.build.toplevel.drvPath != "";
        assert missingKeyFails;
        assert badInstanceNameFails;
        assert tooLongInstanceNameFails;
        pkgs.runCommand "lifemodel-nixos-module-evaluation" {} "touch $out";
    in {
      nixosModules.default = exportedModule;
      checks.${system} = {
        yaml-reserved-instance-names = yamlReservedNamesCheck;
        cli-help = cliHelp;
        bootstrap-field-ownership = bootstrapOwnership;
        bootstrap-activation = bootstrapActivationCheck;
        keyless-defaults = compare "lifemodel-keyless-root" keylessOCI ./tests/fixtures/nixos/keyless-ocirepository.yaml;
        key-mode = compare "lifemodel-key-root" keyOCI ./tests/fixtures/nixos/key-ocirepository.yaml;
        kustomization = compare "lifemodel-root-kustomization"
          (builtins.readFile keyless.config.services.lifemodel.generatedRootKustomization)
          ./tests/fixtures/nixos/kustomization.yaml;
        module-evaluation = moduleEvaluation;
        release-defaults = releaseDefaultsCheck;
        bootstrap-verified-address = bootstrapWaitCheck;
        mdns-module-evaluation = mdnsEvaluation;
        mdns-installer-unit-render = mdnsInstallerUnits;
        platform-kustomize-wiring = renderedPlatform;
        openbao-platform-render = renderedOpenBao;
        cnpg-platform-render = renderedCNPG;
        gitea-platform-render = renderedGitea;
        keyless-identity-agreement = keylessIdentityAgreement;
        install-sh-keyless-ocirepository = compare "lifemodel-install-sh-keyless-root" scriptKeylessOCI ./tests/fixtures/nixos/keyless-ocirepository.yaml;
        install-sh-key-ocirepository = compare "lifemodel-install-sh-key-root" scriptKeyOCI ./tests/fixtures/nixos/key-ocirepository.yaml;
        install-sh-kustomization = compare "lifemodel-install-sh-root-kustomization" scriptKustomization ./tests/fixtures/nixos/kustomization.yaml;
        install-sh-key-requires-public-key = missingKeyFile;
        custom-rendered-strings = compare "lifemodel-custom-rendered-scalars" customOCI ./tests/fixtures/nixos/custom-ocirepository.yaml;
        custom-script-rendered-strings = compare "lifemodel-custom-script-rendered-scalars"
          (builtins.readFile (customScript + "/ocirepository.yaml")) ./tests/fixtures/nixos/custom-ocirepository.yaml;
      };
    };
}

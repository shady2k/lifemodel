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
          mkdir -p $out $TMPDIR/work/scripts $TMPDIR/work/deploy
          cp ${./scripts/install.sh} $TMPDIR/work/scripts/install.sh
          cp -r ${./deploy/root} $TMPDIR/work/deploy/root
          busybox sh $TMPDIR/work/scripts/install.sh --platform-url ${url} --tag ${lib.escapeShellArg tag} \
            --verify ${mode} ${lib.optionalString (mode == "key") "--public-key-file ${pkgs.writeText "platform-cosign.pub" verifyKey}"} \
            --render-only $out ${extraArgs}
        '';
      scriptKeyless = renderOnly "keyless" platformUrl "v1.0.0" "";
      scriptKey = renderOnly "key" platformUrl "v1.0.0" "";
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
        nativeBuildInputs = [ pkgs.kustomize pkgs.gnugrep pkgs.coreutils ];
      } ''
        set -eu
        # Flux first applies the parent source, then reconciles its ./a0 path.
        kustomize build ${./deploy/platform} > parent.yaml
        grep -F 'kind: Kustomization' parent.yaml >/dev/null
        grep -F 'name: platform-a0' parent.yaml >/dev/null
        grep -F 'timeout: 2m0s' parent.yaml >/dev/null
        kustomize build ${./deploy/platform/a0} > a0.yaml
        validate_a0() {
          for kind in Namespace ServiceAccount PersistentVolumeClaim Deployment Service NetworkPolicy Ingress; do
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
        nativeBuildInputs = [ pkgs.kubernetes-helm pkgs.kustomize pkgs.gnugrep pkgs.coreutils ];
      } ''
        set -eux
        helm template openbao ${./deploy/platform/charts/openbao} --namespace openbao \
          -f ${./deploy/platform/a/openbao-values.yaml} > openbao.yaml
        grep -F 'kind: StatefulSet' openbao.yaml >/dev/null
        grep -F 'volumeClaimTemplates:' openbao.yaml >/dev/null
        grep -F 'storage "raft"' openbao.yaml >/dev/null
        grep -F 'serviceAccountName: openbao' openbao.yaml >/dev/null
        grep -A2 -F 'capabilities:' openbao.yaml | grep -F -- '- ALL' >/dev/null
        if grep -F 'automountServiceAccountToken: false' openbao.yaml >/dev/null; then
          echo 'OpenBao pod disables its ServiceAccount token mount' >&2; exit 1
        fi
        grep -F 'pod-security.kubernetes.io/enforce: restricted' ${./deploy/platform/a/namespace.yaml} >/dev/null
        if grep -E 'kind: (Deployment|MutatingWebhookConfiguration)|seal "' openbao.yaml >/dev/null; then
          echo 'OpenBao injector or auto-unseal rendered unexpectedly' >&2; exit 1
        fi
        kustomize build ${./deploy/platform} > platform.yaml
        grep -F 'name: platform-a' platform.yaml >/dev/null
        grep -F 'name: platform-a0' platform.yaml >/dev/null
        kustomize build ${./deploy/platform/a} > step-a.yaml
        grep -F 'kind: HelmRelease' step-a.yaml >/dev/null
        test "$(grep -F -c 'namespaceSelector:' step-a.yaml)" -eq 4
        test "$(grep -F -c 'podSelector:' step-a.yaml)" -eq 6
        test "$(grep -F -c 'kubernetes.io/metadata.name: lifemodel-system' step-a.yaml)" -eq 1
        test "$(grep -F -c 'app.kubernetes.io/name: loader' step-a.yaml)" -eq 1
        test "$(grep -F -c 'port: 8200' step-a.yaml)" -eq 1
        ! grep -F 'ipBlock:' step-a.yaml >/dev/null
        ! grep -F 'egress:' step-a.yaml >/dev/null
        grep -F 'kind: ClusterRoleBinding' step-a.yaml >/dev/null
        grep -F 'name: system:auth-delegator' step-a.yaml >/dev/null
        grep -F 'name: platform' step-a.yaml >/dev/null
        grep -F 'name: platform-a0' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        grep -F 'wait: true' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        grep -F 'timeout: 10m0s' ${./deploy/platform/a-reconciler.yaml} >/dev/null
        touch $out
      '';
      renderedGitea = pkgs.runCommand "lifemodel-gitea-platform-render" {
        nativeBuildInputs = [ pkgs.kubernetes-helm pkgs.kustomize pkgs.gnugrep pkgs.coreutils ];
      } ''
        set -eux
        helm template gitea ${./deploy/platform/charts/gitea} --namespace lifemodel-git \
          -f ${./deploy/platform/a/gitea/values.yaml} > gitea.yaml
        grep -F 'DB_TYPE=sqlite3' gitea.yaml >/dev/null
        grep -F 'PATH=/data/gitea/gitea.db' gitea.yaml >/dev/null
        grep -F 'ROOT=/data/git/repositories' gitea.yaml >/dev/null
        grep -F 'mountPath: /data' gitea.yaml >/dev/null
        grep -F 'name: gitea-admin' gitea.yaml >/dev/null
        grep -E 'key:[[:space:]]+username' gitea.yaml >/dev/null
        grep -E 'key:[[:space:]]+password' gitea.yaml >/dev/null
        grep -F 'claimName: gitea-shared-storage' gitea.yaml >/dev/null
        test "$(grep -F -c 'kind: PersistentVolumeClaim' gitea.yaml)" -eq 1
        grep -F 'host: "git.localhost"' gitea.yaml >/dev/null
        if grep -Ei '^  name: [^ ]*(postgresql|valkey)|^kind: StatefulSet$' gitea.yaml >/dev/null; then
          echo 'Gitea rendered a bundled PostgreSQL or Valkey workload' >&2
          exit 1
        fi
        kustomize build ${./deploy/platform/a/gitea} > gitea-platform.yaml
        test "$(grep -F -c 'namespaceSelector:' gitea-platform.yaml)" -eq 3
        test "$(grep -F -c 'podSelector:' gitea-platform.yaml)" -eq 4
        grep -F 'kubernetes.io/metadata.name: lifemodel-system' gitea-platform.yaml >/dev/null
        grep -F 'kubernetes.io/metadata.name: flux-system' gitea-platform.yaml >/dev/null
        grep -F 'kubernetes.io/metadata.name: kube-system' gitea-platform.yaml >/dev/null
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
        pkgs.runCommand "lifemodel-nixos-module-evaluation" {} "touch $out";
    in {
      nixosModules.default = exportedModule;
      checks.${system} = {
        cli-help = cliHelp;
        bootstrap-field-ownership = bootstrapOwnership;
        bootstrap-activation = bootstrapActivationCheck;
        keyless-defaults = compare "lifemodel-keyless-root" keylessOCI ./tests/fixtures/nixos/keyless-ocirepository.yaml;
        key-mode = compare "lifemodel-key-root" keyOCI ./tests/fixtures/nixos/key-ocirepository.yaml;
        kustomization = compare "lifemodel-root-kustomization"
          (builtins.readFile keyless.config.services.lifemodel.generatedRootKustomization)
          ./tests/fixtures/nixos/kustomization.yaml;
        module-evaluation = moduleEvaluation;
        platform-kustomize-wiring = renderedPlatform;
        openbao-platform-render = renderedOpenBao;
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

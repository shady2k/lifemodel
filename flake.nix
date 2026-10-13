{
  description = "lifemodel NixOS platform bootstrap module";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = nixpkgs.lib;
      module = ./deploy/nixos;
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
      evaluate = extra: lib.nixosSystem { inherit system; modules = [ module baseModule extra ]; };
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
      renderOnly = mode: url: extraArgs:
        pkgs.runCommand "lifemodel-install-sh-render-${mode}" { nativeBuildInputs = [ pkgs.busybox ]; } ''
          mkdir -p $out
          busybox sh ${./scripts/install.sh} --platform-url ${url} --tag v1.0.0 \
            --verify ${mode} ${lib.optionalString (mode == "key") "--public-key-file ${pkgs.writeText "platform-cosign.pub" verifyKey}"} \
            --render-only $out ${extraArgs}
        '';
      scriptKeyless = renderOnly "keyless" platformUrl "";
      scriptKey = renderOnly "key" platformUrl "";
      compare = name: actual: fixture: pkgs.runCommand name {} ''
        printf %s ${lib.escapeShellArg actual} > actual.yaml
        diff -u ${fixture} actual.yaml
        touch $out
      '';
      moduleEvaluation = assert keyless.config.services.k3s.enable;
        assert keyless.config.system.build.toplevel.drvPath != "";
        assert keyMode.config.services.lifemodel.verify.mode == "key";
        assert keyMode.config.system.build.toplevel.drvPath != "";
        assert missingKeyFails;
        pkgs.runCommand "lifemodel-nixos-module-evaluation" {} "touch $out";
    in {
      nixosModules.default = import module;
      checks.${system} = {
        keyless-defaults = compare "lifemodel-keyless-root" keylessOCI ./tests/fixtures/nixos/keyless-ocirepository.yaml;
        key-mode = compare "lifemodel-key-root" keyOCI ./tests/fixtures/nixos/key-ocirepository.yaml;
        kustomization = compare "lifemodel-root-kustomization"
          (builtins.readFile keyless.config.services.lifemodel.generatedRootKustomization)
          ./tests/fixtures/nixos/kustomization.yaml;
        module-evaluation = moduleEvaluation;
        install-sh-keyless-ocirepository = compare "lifemodel-install-sh-keyless-root" scriptKeylessOCI ./tests/fixtures/nixos/keyless-ocirepository.yaml;
        install-sh-key-ocirepository = compare "lifemodel-install-sh-key-root" scriptKeyOCI ./tests/fixtures/nixos/key-ocirepository.yaml;
        install-sh-kustomization = compare "lifemodel-install-sh-root-kustomization" scriptKustomization ./tests/fixtures/nixos/kustomization.yaml;
      };
    };
}

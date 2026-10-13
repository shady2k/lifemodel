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
      keyMode = evaluate ({ ... }: {
        services.lifemodel.verify = {
          mode = "key";
          publicKey = "-----BEGIN PUBLIC KEY-----\nZm9v\n-----END PUBLIC KEY-----";
        };
      });
      missingKey = evaluate ({ ... }: { services.lifemodel.verify.mode = "key"; });
      missingKeyFails = !(builtins.tryEval missingKey.config.system.build.toplevel.drvPath).success;
      keylessOCI = builtins.readFile keyless.config.services.lifemodel.generatedRootOCI;
      keyOCI = builtins.readFile keyMode.config.services.lifemodel.generatedRootOCI;
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
      };
    };
}

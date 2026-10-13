# Root platform source templates

The root GitOps objects that turn a running Flux installation into the
platform layer of ADR-010 (task lifemodel-lut.3.1):

- `ocirepository.yaml` - the one platform source: a Flux `OCIRepository`
  named `platform` in `flux-system`, pinning the signed platform artifact
  and verifying its cosign signature before Flux publishes its artifact.
- `kustomization.yaml` - the root Flux `Kustomization`, also named
  `platform`, applying the artifact's manifests (path `./`, prune, wait)
  once the source is verified.

These are TEMPLATES, not applyable manifests. Placeholders (`@PLATFORM_URL@`,
`@PLATFORM_INSECURE@`, `@REF_BLOCK@`, `@VERIFY_BLOCK@`) are rendered by the
NixOS module in `deploy/nixos/` today; the generic-Linux installer planned
next MUST render the same objects from the same templates. Every
placeholder is uppercase and `@`-delimited, so a template value can never
be mistaken for valid YAML content.

Verification field names follow the Flux docs of the pinned Flux version
(v2.9.6): `spec.verify.provider: cosign`, and either
`spec.verify.matchOIDCIdentity` entries (`issuer` and `subject`, Go regular
expressions) for keyless verification, or `spec.verify.secretRef.name`
pointing at a Secret whose data keys are the trusted public keys ending in
`.pub` for key verification.

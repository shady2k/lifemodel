#!/usr/bin/env python3
"""Validate rendered resources, including OpenAPI primitive types, against vendored CRDs."""
import sys
from pathlib import Path

import yaml


def documents(paths):
    for name in paths:
        with Path(name).open(encoding="utf-8") as stream:
            yield from (item for item in yaml.safe_load_all(stream) if item)


def check(value, schema, path, root):
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: value {value!r} is not one of {schema['enum']!r}")
    schema_type = schema.get("type")
    if schema_type is not None and not (value is None and schema.get("nullable") is True):
        types = schema_type if isinstance(schema_type, list) else [schema_type]

        def matches(type_name):
            if type_name == "object":
                return isinstance(value, dict)
            if type_name == "array":
                return isinstance(value, list)
            if type_name == "string":
                return isinstance(value, str)
            if type_name == "boolean":
                return isinstance(value, bool)
            if type_name == "integer":
                return isinstance(value, int) and not isinstance(value, bool)
            if type_name == "number":
                return isinstance(value, (int, float)) and not isinstance(value, bool)
            if type_name == "null":
                return value is None
            raise ValueError(f"unsupported schema type {type_name} at {path}")

        if not any(matches(type_name) for type_name in types):
            expected = " or ".join(str(type_name) for type_name in types)
            actual = type(value).__name__
            raise ValueError(f"{path}: expected {expected}, got {actual}")
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise ValueError(f"unsupported schema reference {ref} at {path}")
        target = root
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        check(value, target, path, root)
    for branch in schema.get("allOf", []):
        check(value, branch, path, root)
    for key in ("anyOf", "oneOf"):
        branches = schema.get(key, [])
        if branches:
            matches = 0
            errors = []
            for branch in branches:
                try:
                    check(value, branch, path, root)
                    matches += 1
                except ValueError as error:
                    errors.append(str(error))
            if matches == 0 or (key == "oneOf" and matches != 1):
                raise ValueError(f"{path} matches {matches} {key} schemas: {'; '.join(errors)}")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        preserve = schema.get("x-kubernetes-preserve-unknown-fields") is True
        additional = schema.get("additionalProperties", False)
        for required in schema.get("required", []):
            if required not in value:
                raise ValueError(f"{path}.{required}: required field is missing")
        for key, child in value.items():
            if key in properties:
                check(child, properties[key], f"{path}.{key}", root)
            elif preserve:
                continue
            elif isinstance(additional, dict):
                check(child, additional, f"{path}.{key}", root)
            elif additional is True:
                continue
            else:
                raise ValueError(f"{path}.{key}: unknown field")
    elif isinstance(value, list) and "items" in schema:
        for index, child in enumerate(value):
            check(child, schema["items"], f"{path}[{index}]", root)


def main(paths):
    crds = {}
    resources = []
    for item in documents(paths):
        if item.get("kind") == "CustomResourceDefinition":
            spec = item["spec"]
            group = spec["group"]
            kind = spec["names"]["kind"]
            for version in spec["versions"]:
                crds[(group, version["name"], kind)] = version["schema"]["openAPIV3Schema"]
        else:
            resources.append(item)
    checked = 0
    for item in resources:
        api = item.get("apiVersion", "")
        if "/" not in api:
            continue
        group, version = api.split("/", 1)
        schema = crds.get((group, version, item.get("kind")))
        if schema is not None:
            resource = f"{item.get('kind')}/{item.get('metadata', {}).get('name', '?')}"
            if "spec" in item:
                check(item["spec"], schema["properties"]["spec"], f"{resource}.spec", schema)
            checked += 1
    if not checked:
        raise ValueError("no rendered resources matched a vendored CRD")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (KeyError, ValueError, yaml.YAMLError) as error:
        print(f"platform CRD schema validation failed: {error}", file=sys.stderr)
        sys.exit(1)

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { evaluate } from '@marcbachmann/cel-js';

const objects = YAML.parseAllDocuments(
  readFileSync('deploy/platform/a0/task-admission-policies.yaml', 'utf8')
).map((doc) => doc.toJSON());

export function taskAdmissionPolicy(kind: 'Job' | 'Pod'): any {
  return objects.find(
    (item: any) =>
      item.kind === 'ValidatingAdmissionPolicy' &&
      item.metadata.name === `task-${kind.toLowerCase()}-admission`
  );
}

/** Evaluate the shipped CEL guards; this does not replace API-server typechecking/defaulting. */
export function evaluateTaskAdmission(
  kind: 'Job' | 'Pod',
  object: any,
  operation = 'CREATE',
  oldObject: any = null,
  username = kind === 'Job'
    ? 'system:serviceaccount:lifemodel:core'
    : 'system:serviceaccount:kube-system:job-controller'
): string[] {
  const spec = taskAdmissionPolicy(kind).spec;
  const context: any = {
    object,
    oldObject,
    request: { operation, namespace: 'lifemodel-motor', userInfo: { username } },
    variables: {},
  };
  for (const variable of spec.variables ?? [])
    context.variables[variable.name] = evaluate(variable.expression, context);
  return spec.validations
    .filter((rule: any) => evaluate(rule.expression, context) !== true)
    .map((rule: any) => rule.message);
}

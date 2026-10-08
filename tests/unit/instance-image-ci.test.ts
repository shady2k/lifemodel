/**
 * The image's CI, and what the image's own documents claim (lifemodel-q4x.2.2
 * rework 2, findings 2, 3, 4 and 9).
 *
 * A workflow is not covered by the test suite, so its security-relevant shape
 * is read here as a contract: which job may write a package, which one runs the
 * real first start, and what the image's present-state documents may say about
 * egress confinement that does not exist yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const checkout = fileURLToPath(new URL('../..', import.meta.url));

interface Job {
  if?: string;
  permissions?: Record<string, string>;
  'timeout-minutes'?: number;
  steps: { name?: string; uses?: string; with?: Record<string, unknown>; run?: string }[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow: Workflow = parse(
  readFileSync(join(checkout, '.github/workflows/ci.yml'), 'utf8')
) as Workflow;

function read(path: string): string {
  return readFileSync(join(checkout, path), 'utf8');
}

function stepRuns(job: Job): string {
  return job.steps.map((step) => step.run ?? '').join('\n');
}

describe('the image jobs of CI', () => {
  it('builds a pull request image with no write token anywhere in that job', () => {
    const job = workflow.jobs['ci-image'];
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];

    // Nothing a pull request runs may publish: no packages permission, no
    // login, no push (rework 2, finding 2).
    expect(job?.permissions ?? workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(stepRuns(job as Job)).not.toContain('docker login');
    expect(stepRuns(job as Job)).not.toContain('docker push');
    // The checkout keeps no credential either: a same-repository pull request
    // can edit the scripts this job runs.
    const checkoutStep = steps.find((step) => step.uses?.startsWith('actions/checkout'));
    expect(checkoutStep?.with?.['persist-credentials']).toBe(false);
    // It runs for a pull request only, and it fails closed when the classifier
    // itself failed, like ci-product.
    expect(job?.if).toContain("github.event_name == 'pull_request'");
    expect(job?.if).toContain("needs.changes.result != 'success'");
  });

  it('proves boot on a pull request: the real first start inside the image', () => {
    const job = workflow.jobs['ci-image'] as Job;
    const runs = stepRuns(job);

    // The build is the same script a person runs, and the walk that follows it
    // is the gated end-to-end test (rework 2, finding 9).
    expect(runs).toContain('scripts/build-image.sh');
    expect(runs).toContain('LIFEMODEL_DOCKER_TESTS=1');
    expect(runs).toContain('tests/integration/instance-first-start.test.ts');
    // The walk boots the image this job built, not a second build (rework 3).
    expect(runs).toContain('LIFEMODEL_TEST_IMAGE="ghcr.io/shady2k/lifemodel:ci-$SHA"');
    expect(runs).toContain('scripts/build-image.sh "ci-$SHA"');
    // It needs the repository's own node_modules for that test.
    expect(runs).toContain('npm ci');
    // And it is bounded: the walk builds an image and starts an instance.
    expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('publishes main and the commit on every push to main, and only there', () => {
    const job = workflow.jobs['ci-image-publish'] as Job;
    expect(job).toBeDefined();
    const runs = stepRuns(job);

    // The one job that may write a package (rework 2, finding 2).
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(runs).toContain('docker login ghcr.io');
    expect(runs).toContain('ghcr.io/shady2k/lifemodel:main');
    expect(runs).toContain('ghcr.io/shady2k/lifemodel:$SHA');
    // Push only: a pull request never reaches it.
    expect(job.if).toContain("github.event_name == 'push'");
    // NO classifier gate on a push: every main push publishes, a documents-only
    // one included (rework 2, finding 4).
    expect(job.if).not.toContain('needs.changes');
    expect(job.if).not.toContain('outputs.product');
  });

  it('is the only job that asks for a write permission', () => {
    const writing = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.['packages'] === 'write')
      .map(([name]) => name);

    expect(writing).toEqual(['ci-image-publish']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });
});

describe('what the image says about confining lifemodel (lifemodel-q4x.3.2)', () => {
  it('claims the egress rule in the present tense, and the source installs one', () => {
    // The rule exists now: the loader installs it before lifemodel starts, so
    // the present-state documents say so in the present tense (this test used
    // to assert the opposite, with the day it changes named as its reminder).
    expect(read('loader/src/egress.ts')).toContain('--uid-owner');
    expect(read('loader/src/app.ts')).toContain('await egress.install()');
    // The supervisor does not touch the kernel: the rule is the loader's own.
    expect(read('loader/src/supervisor.ts')).not.toContain('iptables');

    const readme = read('README.md');
    expect(readme).toContain('lifemodel-q4x.3.2');
    expect(readme).toContain('NET_ADMIN');
    // Present tense: lifemodel's traffic IS confined by the rule the loader
    // installs, and the flag IS what that rule needs.
    expect(readme).toContain('egress rule');
    expect(readme).not.toMatch(/No such rule is\s+installed today/);
    expect(readme).not.toMatch(/carried, not\s+yet used/);

    const dockerfile = read('docker/instance/Dockerfile');
    expect(dockerfile).toContain('lifemodel-q4x.3.2');
    expect(dockerfile).not.toContain('NO SUCH RULE EXISTS YET');
  });
});

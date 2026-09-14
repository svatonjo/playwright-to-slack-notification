import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

interface PwError {
  message?: string;
}

interface PwTestResult {
  duration?: number;
  error?: PwError;
  errors?: PwError[];
}

interface PwTest {
  projectName?: string;
  status: 'expected' | 'unexpected' | 'skipped' | 'flaky';
  results: PwTestResult[];
}

interface PwSpec {
  title: string;
  file: string;
  tests: PwTest[];
}

interface PwSuite {
  specs: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  stats: {
    startTime?: string;
    duration?: number;
    expected: number;
    unexpected: number;
    skipped: number;
    flaky: number;
  };
  suites: PwSuite[];
}

interface FailedTestEntry {
  title: string;
  file: string;
  projectName: string | null;
  status: 'failed' | 'flaky';
  durationMs: number;
  errorMessage: string | null;
}

interface SlackSummary {
  generatedAt: string;
  pipeline: {
    definitionName: string | null;
    buildNumber: string | null;
    buildId: string | null;
    branchName: string | null;
    buildUrl: string | null;
    artifactsUrl: string | null;
    reportArtifactUrl: string | null;
  };
  environment: {
    baseUrl: string | null;
    expectedEnvironmentText: string | null;
  };
  stats: {
    startedAt: string | null;
    durationMs: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    total: number;
  };
  failedTests: FailedTestEntry[];
}

function collectSpecs(suites: PwSuite[]): PwSpec[] {
  const specs: PwSpec[] = [];

  for (const suite of suites) {
    specs.push(...(suite.specs ?? []));
    if (suite.suites) {
      specs.push(...collectSpecs(suite.suites));
    }
  }

  return specs;
}

function getBuildUrl(): string | null {
  const collectionUri = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  const teamProject = process.env.SYSTEM_TEAMPROJECT;
  const buildId = process.env.BUILD_BUILDID;

  if (!collectionUri || !teamProject || !buildId) {
    return null;
  }

  return `${collectionUri}${teamProject}/_build/results?buildId=${buildId}&view=results`;
}

function getArtifactsUrl(): string | null {
  const collectionUri = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  const teamProject = process.env.SYSTEM_TEAMPROJECT;
  const buildId = process.env.BUILD_BUILDID;

  if (!collectionUri || !teamProject || !buildId) {
    return null;
  }

  return `${collectionUri}${teamProject}/_build/results?buildId=${buildId}&view=artifacts&type=publishedArtifacts`;
}

function getReportArtifactUrl(): string | null {
  const artifactsUrl = getArtifactsUrl();
  return artifactsUrl ? `${artifactsUrl}&artifactName=PlaywrightTestReport` : null;
}

function normalizeErrorMessage(test: PwTest): string | null {
  for (const result of test.results ?? []) {
    const firstError = result.error ?? result.errors?.[0];
    if (firstError?.message) {
      return firstError.message.split('\n')[0].trim();
    }
  }

  return null;
}

function totalDuration(test: PwTest): number {
  return (test.results ?? []).reduce((sum, result) => sum + (result.duration ?? 0), 0);
}

function createSlackSummary(report: PwReport): SlackSummary {
  const failedTests: FailedTestEntry[] = [];

  for (const spec of collectSpecs(report.suites ?? [])) {
    for (const test of spec.tests ?? []) {
      if (test.status !== 'unexpected' && test.status !== 'flaky') {
        continue;
      }

      failedTests.push({
        title: spec.title,
        file: spec.file,
        projectName: test.projectName ?? null,
        status: test.status === 'flaky' ? 'flaky' : 'failed',
        durationMs: totalDuration(test),
        errorMessage: normalizeErrorMessage(test),
      });
    }
  }

  const artifactsUrl = getArtifactsUrl();
  const stats = report.stats;

  return {
    generatedAt: new Date().toISOString(),
    pipeline: {
      definitionName: process.env.BUILD_DEFINITIONNAME ?? null,
      buildNumber: process.env.BUILD_BUILDNUMBER ?? null,
      buildId: process.env.BUILD_BUILDID ?? null,
      branchName: process.env.BUILD_SOURCEBRANCHNAME ?? null,
      buildUrl: getBuildUrl(),
      artifactsUrl,
      reportArtifactUrl: getReportArtifactUrl(),
    },
    environment: {
      baseUrl: process.env.BASE_URL ?? null,
      expectedEnvironmentText: process.env.EXPECTED_ENVIRONMENT_TEXT ?? null,
    },
    stats: {
      startedAt: stats?.startTime ?? null,
      durationMs: stats?.duration ?? 0,
      passed: stats?.expected ?? 0,
      failed: stats?.unexpected ?? 0,
      skipped: stats?.skipped ?? 0,
      flaky: stats?.flaky ?? 0,
      total: (stats?.expected ?? 0) + (stats?.unexpected ?? 0) + (stats?.skipped ?? 0) + (stats?.flaky ?? 0),
    },
    failedTests,
  };
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusEmoji(summary: SlackSummary): string {
  if (summary.stats.failed > 0) {
    return '🚨';
  }

  if (summary.stats.flaky > 0) {
    return '⚠️';
  }

  return '✅';
}

function postJson(url: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }

        reject(new Error(`Slack webhook returned ${response.statusCode ?? 'unknown'}: ${responseBody}`));
      });
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

const inputPath = path.resolve(
  process.env.PLAYWRIGHT_JSON_REPORT ?? 'test-results/results.json',
);

if (!fs.existsSync(inputPath)) {
  console.error(`[slack-notify] Playwright JSON report not found: ${inputPath}`);
  process.exit(1);
}

const report: PwReport = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const summary = createSlackSummary(report);

if (summary.stats.failed === 0) {
  console.log('[slack-notify] No failed tests. Skipping Slack notification.');
  process.exit(0);
}

const webhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!webhookUrl) {
  console.error('[slack-notify] SLACK_WEBHOOK_URL is not configured.');
  process.exit(1);
}

const failedLines = summary.failedTests
  .slice(0, 10)
  .map((test, index) => {
    const title = escapeSlackText(test.title);
    const file = escapeSlackText(test.file);
    const errorMessage = test.errorMessage ? `\n    ${escapeSlackText(test.errorMessage)}` : '';
    return `${index + 1}. ${title}\n    ${file}${errorMessage}`;
  });

const moreFailuresCount = Math.max(summary.failedTests.length - failedLines.length, 0);
const runLabel = escapeSlackText(summary.pipeline.buildNumber ?? summary.pipeline.buildId ?? 'unknown');
const pipelineLabel = escapeSlackText(summary.pipeline.definitionName ?? 'unknown');
const branchLabel = escapeSlackText(summary.pipeline.branchName ?? 'unknown');
const environmentLabel = escapeSlackText(summary.environment.expectedEnvironmentText ?? summary.environment.baseUrl ?? 'unknown');
const totalFailuresLabel = `${summary.stats.failed} failed`;
const flakyLabel = `${summary.stats.flaky} flaky`;
const passedLabel = `${summary.stats.passed} passed`;
const skippedLabel = `${summary.stats.skipped} skipped`;
const durationLabel = formatDuration(summary.stats.durationMs);

const blocks: Array<Record<string, unknown>> = [
  {
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${statusEmoji(summary)} Playwright pipeline failed`,
    },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${pipelineLabel}* run *${runLabel}* has test failures.`,
    },
  },
  {
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*Branch*\n${branchLabel}`,
      },
      {
        type: 'mrkdwn',
        text: `*Environment*\n${environmentLabel}`,
      },
      {
        type: 'mrkdwn',
        text: `*Results*\n${totalFailuresLabel} / ${passedLabel}`,
      },
      {
        type: 'mrkdwn',
        text: `*Other*\n${skippedLabel} / ${flakyLabel}`,
      },
      {
        type: 'mrkdwn',
        text: `*Duration*\n${durationLabel}`,
      },
      {
        type: 'mrkdwn',
        text: `*Generated*\n${escapeSlackText(summary.generatedAt)}`,
      },
    ],
  },
];

const actionElements: Array<Record<string, unknown>> = [];

if (summary.pipeline.buildUrl) {
  actionElements.push({
    type: 'button',
    text: {
      type: 'plain_text',
      text: 'Open Run',
    },
    url: summary.pipeline.buildUrl,
  });
}

if (summary.pipeline.reportArtifactUrl) {
  actionElements.push({
    type: 'button',
    text: {
      type: 'plain_text',
      text: 'Playwright Report',
    },
    url: summary.pipeline.reportArtifactUrl,
  });
} else if (summary.pipeline.artifactsUrl) {
  actionElements.push({
    type: 'button',
    text: {
      type: 'plain_text',
      text: 'Artifacts',
    },
    url: summary.pipeline.artifactsUrl,
  });
}

if (actionElements.length > 0) {
  blocks.push({
    type: 'actions',
    elements: actionElements,
  });
}

blocks.push({
  type: 'divider',
});

blocks.push({
  type: 'section',
  text: {
    type: 'mrkdwn',
    text: `*Failed tests*\n${failedLines.join('\n')}${moreFailuresCount > 0 ? `\n…and ${moreFailuresCount} more` : ''}`,
  },
});

postJson(webhookUrl, {
  text: `Playwright pipeline failed: ${summary.stats.failed} failed in ${runLabel}`,
  blocks,
})
  .then(() => {
    console.log('[slack-notify] Slack notification sent.');
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[slack-notify] Failed to send Slack notification: ${message}`);
    process.exit(1);
  });
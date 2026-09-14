# Playwright to Slack Notification

Small Node.js utility that reads a Playwright JSON report and posts failed tests to Slack using an incoming webhook.

The script reads `test-results/results.json` directly. No intermediate summary file or summary-generation script is needed. It sends a Slack message only when the report contains failed tests.

## Requirements

- Node.js 20 or newer
- npm
- A Slack incoming webhook URL
- Playwright configured with the JSON reporter

## Installation

```powershell
git clone https://github.com/svatonjo/playwright-to-slack-notification.git
cd playwright-to-slack-notification
npm install
```

## Configure Playwright

Configure the Playwright JSON reporter to write the expected input file:

```typescript
export default defineConfig({
  reporter: [
    ['html'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
});
```

Run the tests before invoking the notifier:

```powershell
npx playwright test
```

By default, the input path is resolved relative to the current working directory. Set `PLAYWRIGHT_JSON_REPORT` to use another location.

## Local usage

Set the webhook only for the current PowerShell session, point to a Playwright JSON report, and run:

```powershell
$env:SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/...'
$env:PLAYWRIGHT_JSON_REPORT = 'C:\path\to\playwright-project\test-results\results.json'
npm run notify
```

## Use from a Playwright project

Run the notifier while the current directory is the Playwright project so it finds `test-results/results.json` automatically:

```powershell
$env:SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/...'
npx tsx C:\path\to\playwright-to-slack-notification\post-slack-notification.ts
```

If the Playwright project keeps its own copy of the script, add this package script:

```json
{
  "scripts": {
    "slack:notify": "tsx scripts/post-slack-notification.ts"
  }
}
```

Then run `npm run slack:notify` after the Playwright test command.

## Azure Pipelines

Store `SLACK_WEBHOOK_URL` as a secret pipeline variable. Run the notification step after Playwright:

```yaml
- script: npx tsx path/to/post-slack-notification.ts
  displayName: Post Slack notification on failed tests
  condition: succeededOrFailed()
  env:
    SLACK_WEBHOOK_URL: $(SLACK_WEBHOOK_URL)
    BASE_URL: $(BASE_URL)
    EXPECTED_ENVIRONMENT_TEXT: $(EXPECTED_ENVIRONMENT_TEXT)
```

Azure Pipelines build variables are read automatically to create run, branch, artifact, and Playwright report links. The working directory must contain `test-results/results.json`, or `PLAYWRIGHT_JSON_REPORT` must point to it.

## Behavior

- No failed tests: exits successfully without sending a message.
- Missing Playwright JSON report: exits with code 1.
- Missing `SLACK_WEBHOOK_URL`: exits with code 1 when failures exist.
- Slack returns a non-2xx response: exits with code 1 and logs the response.
- More than 10 failed tests: includes the first 10 and reports how many remain.
- Pipeline and artifact URLs: adds buttons when those URLs are present in the summary.

## Validation

```powershell
npm run typecheck
```
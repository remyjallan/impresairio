const reviewOutput = process.env.PR_REVIEW_OUTPUT?.trim();
const labels = new Set(
  (process.env.PR_REVIEW_LABELS ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean),
);

if (labels.has('ai-review-override')) {
  console.warn('AI review gate overridden by the ai-review-override label.');
  process.exit(0);
}

if (!reviewOutput) {
  fail('PR-Agent did not expose a review result to the AI review gate.');
}

let review;
try {
  review = JSON.parse(reviewOutput);
} catch (error) {
  fail(`PR-Agent returned invalid review JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (!review || typeof review !== 'object' || Array.isArray(review)) {
  fail('PR-Agent returned an invalid review object.');
}

const issues = Array.isArray(review.key_issues_to_review)
  ? review.key_issues_to_review.filter((issue) => {
      if (issue === null || issue === undefined) return false;
      return typeof issue !== 'string' || issue.trim().length > 0;
    })
  : null;

if (!issues) {
  fail('PR-Agent review JSON is missing the key_issues_to_review array.');
}

const security = String(review.security_concerns ?? '').trim().toLowerCase();
const securityFinding = security.length > 0 && !['no', 'none', 'false', 'n/a', 'not applicable'].includes(security);

if (issues.length > 0 || securityFinding) {
  console.error('AI review gate failed. PR-Agent reported actionable findings:');
  for (const issue of issues) console.error(`- ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`);
  if (securityFinding) console.error(`- Security concerns: ${review.security_concerns}`);
  process.exit(1);
}

console.log('AI review gate passed: PR-Agent reported no actionable findings.');

function fail(message) {
  console.error(`AI review gate failed: ${message}`);
  process.exit(1);
}

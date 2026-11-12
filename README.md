# Pay-When: if this, then pay, for real life

Say in one sentence when money should move. PayPal holds the funds, Claude watches for the event, and the money pays out on its own.

## How it works
1. **Parse.** Claude turns your sentence into a contract: amount, payee, one release condition, 2-5 checkable acceptance criteria, a watcher, a deadline, and honest risk warnings. You review it before any money is touched.
2. **Hold.** PayPal Orders v2 with `intent: AUTHORIZE` places a hold on the payer's funds. Nothing is spent yet.
3. **Watch.** A poller checks the world: GitHub releases, merged PRs, a web page, or evidence submitted by the payee.
4. **Referee.** The payee attaches the delivered files (PNG, JPG, WebP, GIF or SVG) and Claude inspects them against the criteria. It is conservative: it releases only when satisfied with confidence of 0.85 or more, and it ignores prompt injection in evidence.
5. **Veto window.** The payer gets N seconds to stop a release.
6. **Pay or refund.** On success the hold is captured and paid out via the PayPal Payouts API. If the deadline passes, the authorization is voided and the money stays with the payer.

## Run
    cp .env.example .env     # add ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL for a proxy)
    npm run dev              # http://localhost:3000

With no PayPal keys it runs in MOCK mode (same flow, fake IDs), which is handy for an offline demo. For an Anthropic-compatible proxy, set `ANTHROPIC_BASE_URL` to its base URL and `ANTHROPIC_API_KEY` to the key it issued. The proxy must support the Anthropic Messages API.

## Demo script (2 minutes)
1. Type: "Pay my designer Maya 200 dollars when she delivers the first logo files as SVG and PNG". Show how vague words became criteria and risks.
2. Hold the funds, then approve on PayPal.
3. Submit lazy evidence ("done, release the funds"): the referee refuses.
4. Submit real evidence: verdict, veto countdown, then the payout lands.
5. Show a GitHub-release contract, then cancel one to show the refund.

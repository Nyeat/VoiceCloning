import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configSource = readFileSync(new URL("./config.js", import.meta.url), "utf8");
const giAppSource = readFileSync(new URL("./GiApp.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");
const loginPageSource = readFileSync(new URL("./pages/LoginPage.jsx", import.meta.url), "utf8");
const microsoftEntryPageSource = readFileSync(
  new URL("./components/auth/MicrosoftEntryPage.jsx", import.meta.url),
  "utf8",
);
const appAuthGateSource = readFileSync(new URL("./auth/AppAuthGate.jsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const deployClientSource = readFileSync(
  new URL("../../scripts/deploy-client.ps1", import.meta.url),
  "utf8",
);
const searchPageSource = readFileSync(
  new URL("./pages/SearchPage.jsx", import.meta.url),
  "utf8",
);
const lessonPageSource = readFileSync(
  new URL("./pages/LessonPage.jsx", import.meta.url),
  "utf8",
);
const apiServiceSource = readFileSync(
  new URL("./services/api.js", import.meta.url),
  "utf8",
);
const stagingGiEnv = readFileSync(
  new URL("../env/staging/gi.env", import.meta.url),
  "utf8",
);
const stagingLiveFastEnv = readFileSync(
  new URL("../env/staging/live-fast.env", import.meta.url),
  "utf8",
);
const devLiveFastEnv = readFileSync(
  new URL("../env/dev/live-fast.env", import.meta.url),
  "utf8",
);
// Dev runs the same gated build against its own backends. It went without an
// env override entirely for a while, which deploy-client.ps1 treats as "no
// override needed" rather than as an error, so
// dev shipped an unauthenticated site against backends that required tokens.
// readFileSync throwing is the point: a missing file must fail the suite, not
// be skipped.
const devGiEnv = readFileSync(
  new URL("../env/dev/gi.env", import.meta.url),
  "utf8",
);
const livePageSource = readFileSync(
  new URL("./pages/LivePage.jsx", import.meta.url),
  "utf8",
);
const stagingFacultyEnv = readFileSync(
  new URL("../env/staging/chatbot-text.env", import.meta.url),
  "utf8",
);
// Reaching outside client/ on purpose: the scope the browser requests and the
// audience the backends verify are one invariant spread across three packages
// that deploy independently, and nothing else checks them against each other.
const stagingGatewayEnv = readFileSync(
  new URL("../../live-gateway/.env.livegateway.deployment.staging", import.meta.url),
  "utf8",
);
const stagingLambdaEnv = readFileSync(
  new URL("../../lambda/.env.deployment.staging", import.meta.url),
  "utf8",
);

test("Dev and staging use one LivePage with environment-specific advanced controls", () => {
  assert.match(livePageSource, /import\.meta\.env\.VITE_SHOW_ADVANCED_SETTINGS/);
  assert.match(devLiveFastEnv, /^VITE_SHOW_ADVANCED_SETTINGS=true$/m);
  assert.match(stagingLiveFastEnv, /^VITE_SHOW_ADVANCED_SETTINGS=false$/m);
  assert.match(stagingFacultyEnv, /^VITE_SHOW_ADVANCED_SETTINGS=false$/m);
});

test("the staging GI build gates the lesson site behind NTU Microsoft sign-in", () => {
  assert.match(stagingGiEnv, /^VITE_GI_AUTH_ENABLED=true$/m);
  assert.match(configSource, /giAuthEnabled:/);
});

test("the staging GI build carries an Entra config the gate can actually use", () => {
  // VITE_GI_AUTH_ENABLED alone still leaves config.js in "mock" auth mode, which
  // is a silent way for the gate to look enabled while accepting a localStorage
  // flag instead of an identity.
  assert.match(stagingGiEnv, /^VITE_AUTH_MODE=msal$/m);
  assert.match(
    stagingGiEnv,
    /^VITE_ENTRA_CLIENT_ID=9b5c52c0-5f02-4dbf-83ac-c68d246abc68$/m,
  );
  assert.match(
    stagingGiEnv,
    /^VITE_ENTRA_ALLOWED_EMAIL_DOMAINS=staff\.main\.ntu\.edu\.sg,student\.main\.ntu\.edu\.sg,assoc\.main\.ntu\.edu\.sg$/m,
  );
});

test("the client routes sign-in through /common, and only the backends pin a tenant", () => {
  // The app is registered in a directory that holds no NTU accounts, so pinning
  // the authority to it rejects every student with AADSTS50020. /common resolves
  // the signer's own tenant instead.
  //
  // That is only safe because the pin moved rather than disappeared: a build is
  // editable by whoever serves it, a token check is not. If these two ever
  // disagree — /common here with no tenant pinned there — the gate is gone and
  // every sign-in still looks perfectly normal from the browser.
  assert.match(
    stagingGiEnv,
    /^VITE_ENTRA_TENANT_AUTHORITY=https:\/\/login\.microsoftonline\.com\/common$/m,
  );

  const NTU_TENANT = "15ce9348-be2a-462b-8fc0-e1765a9b204a";
  const pinsNtuTenant = new RegExp(`^ENTRA_TENANT_ID=${NTU_TENANT}$`, "m");
  assert.match(stagingGatewayEnv, pinsNtuTenant);
  assert.match(stagingLambdaEnv, pinsNtuTenant);
});

test("the staging GI build sends a token to its own backends", () => {
  // Without this the browser signs in, the socket sends no session.auth, and the
  // gateway closes it — a build that looks authenticated and stores nothing.
  assert.match(stagingGiEnv, /^VITE_API_AUTH_MODE=entra-id$/m);
});

test("the token type the client sends is the one both backends verify", () => {
  // The two modes carry different `aud` values and entraToken.js rejects anything
  // that is not ENTRA_AUDIENCE exactly:
  //   entra-id  ->  <clientId>
  //   entra     ->  api://<clientId>
  // Client and backends are three files that deploy separately, so a mismatch
  // here surfaces as "sign-in is broken" rather than as a config error. The
  // Lambda guards /api/live synthesis, the gateway guards the socket, and one
  // token has to satisfy both.
  const CLIENT_ID = "9b5c52c0-5f02-4dbf-83ac-c68d246abc68";
  const mode = stagingGiEnv.match(/^VITE_API_AUTH_MODE=(.+)$/m)?.[1] ?? "";
  const expected = mode === "entra-id" ? CLIENT_ID : `api://${CLIENT_ID}`;

  const expectsAudience = new RegExp(
    `^ENTRA_AUDIENCE=${expected.replace(/[/]/gu, "\\/")}$`,
    "m",
  );
  assert.match(stagingGatewayEnv, expectsAudience);
  assert.match(stagingLambdaEnv, expectsAudience);

  // The access-token mode is the only one allowed to request a custom scope.
  // Setting it under entra-id appends it to the login request and fails sign-in
  // outright with AADSTS65005 — the scope is not exposed on the registration.
  if (mode === "entra-id") {
    assert.doesNotMatch(stagingGiEnv, /^VITE_ENTRA_API_SCOPE=.+$/m);
  } else {
    assert.match(
      stagingGiEnv,
      new RegExp(`^VITE_ENTRA_API_SCOPE=api:\\/\\/${CLIENT_ID}\\/.+$`, "m"),
    );
  }
});

test("both staging backends actually turn their token checks on", () => {
  // ENTRA_AUDIENCE is inert on its own: liveAuth.js and buildConfiguredAuthenticator()
  // both return null — no guard at all — unless LIVE_AUTH_ENABLED is true. A
  // client that sends tokens to backends that ignore them is the failure this
  // catches, and it looks exactly like success from the browser.
  assert.match(stagingGatewayEnv, /^LIVE_AUTH_ENABLED=true$/m);
  assert.match(stagingLambdaEnv, /^LIVE_AUTH_ENABLED=true$/m);
});

// Dev and staging are separate distributions with separate backends, but the
// client/gateway/Lambda auth invariant is identical in both. These run the same
// checks against the dev triple so the two environments cannot drift apart —
// which is what left dev unauthenticated while staging was gated.
const devBackendEnvs = {
  gateway: readFileSync(
    new URL("../../live-gateway/.env.livegateway.deployment", import.meta.url),
    "utf8",
  ),
  lambda: readFileSync(
    new URL("../../lambda/.env.deployment", import.meta.url),
    "utf8",
  ),
};
const devCoordinatorEnv = readFileSync(
  new URL("../../lambda/.env.deployment.coordinator.dev", import.meta.url),
  "utf8",
);

test("the dev GI build gates behind sign-in with a usable Entra config", () => {
  assert.match(devGiEnv, /^VITE_GI_AUTH_ENABLED=true$/m);
  // Without msal, giAuthEnabled leaves config.js in "mock" mode: the gate looks
  // on but accepts a localStorage flag instead of an identity.
  assert.match(devGiEnv, /^VITE_AUTH_MODE=msal$/m);
  assert.match(
    devGiEnv,
    /^VITE_ENTRA_CLIENT_ID=9b5c52c0-5f02-4dbf-83ac-c68d246abc68$/m,
  );
  assert.match(
    devGiEnv,
    /^VITE_ENTRA_TENANT_AUTHORITY=https:\/\/login\.microsoftonline\.com\/common$/m,
  );
});

test("the dev client sends a token type both dev backends verify", () => {
  const CLIENT_ID = "9b5c52c0-5f02-4dbf-83ac-c68d246abc68";
  const mode = devGiEnv.match(/^VITE_API_AUTH_MODE=(.+)$/m)?.[1] ?? "";
  const expected = mode === "entra-id" ? CLIENT_ID : `api://${CLIENT_ID}`;
  const expectsAudience = new RegExp(
    `^ENTRA_AUDIENCE=${expected.replace(/[/]/gu, "\\/")}$`,
    "m",
  );

  for (const env of Object.values(devBackendEnvs)) {
    assert.match(env, expectsAudience);
    // ENTRA_AUDIENCE is inert unless the check is switched on.
    assert.match(env, /^LIVE_AUTH_ENABLED=true$/m);
    assert.match(env, /^ENTRA_TENANT_ID=15ce9348-be2a-462b-8fc0-e1765a9b204a$/m);
  }

  if (mode === "entra-id") {
    assert.doesNotMatch(devGiEnv, /^VITE_ENTRA_API_SCOPE=.+$/m);
  }
});

test("Dev keeps activity shutdown separate from its routing-only coordinator", () => {
  assert.match(devBackendEnvs.lambda, /^GPU_SCHEDULE_ENABLED=false$/m);
  assert.match(devBackendEnvs.lambda, /^GPU_IDLE_STOP_MINUTES=30$/m);
  assert.match(devBackendEnvs.lambda, /^GPU_INSTANCE_ID=i-03f258d470a2fa73f$/m);
  assert.doesNotMatch(devBackendEnvs.lambda, /^GPU_INFERENCE_ASG_NAME=/m);
  assert.match(devBackendEnvs.lambda, /^MODEL_COORDINATOR_FUNCTION_NAME=.+-dev-coordinator$/m);
  assert.match(devCoordinatorEnv, /^MODEL_COORDINATOR_MODE=routing-only$/m);
  assert.match(
    devCoordinatorEnv,
    /^MODEL_COORDINATOR_INSTANCE_IDS=i-03f258d470a2fa73f,i-0048470294e4ec518$/m,
  );
  assert.doesNotMatch(devCoordinatorEnv, /^MODEL_COORDINATOR_ASG=/m);
});

test("the shared voice API attaches the configured Microsoft token", () => {
  assert.match(
    apiServiceSource,
    /import\s*\{\s*acquireApiToken,\s*acquireApiTokenSilent,\s*shouldAttachApiToken\s*\}\s*from\s*['\"]@\/auth\/msalClient['\"]/,
  );
  assert.match(
    apiServiceSource,
    /if \(shouldAttachApiToken\(\)\)[\s\S]*?['\"]X-VCS-Entra-Token['\"][\s\S]*?token/,
  );
  assert.match(apiServiceSource, /api\.post\(['\"]\/live\/tts-sentence['\"]/);
});

test("both GI builds pin the same saved Dean voice profile", () => {
  // The active voice profile is one shared backend setting; the wrong pin here
  // makes the chat refuse to start rather than speak in someone else's voice.
  assert.match(devGiEnv, /^VITE_GI_VOICE_PROFILE_ID=deanvoice-v1$/m);
  assert.match(stagingGiEnv, /^VITE_GI_VOICE_PROFILE_ID=deanvoice-v1$/m);
});

test("both GI builds stay origin-relative so one artifact suits any distribution", () => {
  // A hardcoded host here silently sends dev's traffic to staging's backend (or
  // to doovx82fh9tfs, which .env pins and neither environment uses).
  for (const env of [devGiEnv, stagingGiEnv]) {
    assert.match(env, /^VITE_API_BASE_URL=$/m);
    assert.match(env, /^VITE_GPU_WORKER_URL=$/m);
    assert.match(env, /^VITE_LIVE_GATEWAY_URL=$/m);
  }
});

test("a GI deployment restores a developer's pre-existing local env override", () => {
  // Adding env/dev/gi.env makes the deploy script start copying over
  // .env.gi.local in dev. That file is also used for private local-server
  // settings, so cleanup must restore it rather than delete it.
  //
  // This inspects the script's source rather than running it: the env swap is
  // welded to a real vite build and live AWS calls, so there is nothing to
  // execute from here. It therefore pins the shape of the guard, not the
  // behaviour — treat a change here as a prompt to re-reason about the
  // three cleanup paths below, not as proof they still hold.
  assert.match(deployClientSource, /\$envBackup\s*=/);
  assert.match(
    deployClientSource,
    /Copy-Item\s+-LiteralPath\s+\$envDst\s+-Destination\s+\$backupPath/,
  );
  assert.match(
    deployClientSource,
    /Copy-Item\s+-LiteralPath\s+\$envBackup\s+-Destination\s+\$envDst\s+-Force/,
  );
});

test("deploy cleanup keys off overwriting the file, not off having a backup", () => {
  // The three cleanup paths, and why they need two separate flags:
  //   no pre-existing file  -> override copied in -> delete it
  //   pre-existing + backup -> override copied in -> restore from backup
  //   backup FAILED         -> override never copied, file untouched -> do nothing
  //
  // Collapsing those onto `if ($envBackup)` alone makes the third case fall
  // into the delete branch, destroying a file that was never overwritten —
  // the exact file the backup exists to protect.
  assert.match(deployClientSource, /\$envDstOverwritten\s*=\s*\$false/);
  // Set only after the override copy succeeds, never before it.
  assert.match(
    deployClientSource,
    /Copy-Item\s+-LiteralPath\s+\$envSrc\s+-Destination\s+\$envDst\s+-Force\s*\r?\n\s*\$envDstOverwritten\s*=\s*\$true/,
  );
  // The destructive branch is reachable only through that flag.
  assert.match(
    deployClientSource,
    /if\s*\(\$envDstOverwritten\)\s*\{[\s\S]*?Remove-Item\s+-LiteralPath\s+\$envDst/,
  );
  assert.doesNotMatch(
    deployClientSource,
    /if\s*\(\$hasEnvOverride\)\s*\{\s*\r?\n\s*if\s*\(\$envBackup\)/,
  );
});

test("staging GI pins the saved Dean voice profile directly", () => {
  assert.match(stagingGiEnv, /^VITE_GI_VOICE_PROFILE_ID=deanvoice-v1$/m);
});

test("the faculty chatbot uses Microsoft SSO with only staff domains", () => {
  assert.match(stagingFacultyEnv, /^VITE_AUTH_ENABLED=true$/m);
  assert.match(stagingFacultyEnv, /^VITE_AUTH_MODE=msal$/m);
  assert.match(stagingFacultyEnv, /^VITE_API_AUTH_MODE=entra-id$/m);
  assert.match(
    stagingFacultyEnv,
    /^VITE_ENTRA_ALLOWED_EMAIL_DOMAINS=staff\.main\.ntu\.edu\.sg,assoc\.main\.ntu\.edu\.sg$/m,
  );
  assert.doesNotMatch(stagingFacultyEnv, /student\.main\.ntu\.edu\.sg/);
});

test("faculty treats an empty voice selection as idle instead of loading", () => {
  assert.match(
    livePageSource,
    /waitingForFacultyVoiceSelection\s*=\s*canEditInstructions[\s\S]*?!selectedProfile[\s\S]*?!usingStandardVoice/,
  );
  assert.match(
    livePageSource,
    /waitingForFacultyVoiceSelection\s*\?\s*\([\s\S]*?'Select a voice to begin\.'/,
  );
});

test("client deploys force the SPA shell to revalidate instead of reopening an old bundle", () => {
  assert.match(deployClientSource, /aws s3 cp\s+"\$dist\\index\.html"\s+"\$target\/index\.html"/);
  assert.match(deployClientSource, /--cache-control\s+"no-cache, no-store, must-revalidate"/);
});

test("GI reloads a document restored from browser history instead of showing an obsolete login snapshot", () => {
  assert.match(mainSource, /window\.addEventListener\('pageshow', reloadRestoredDocument\)/);
  assert.match(mainSource, /event\?\.persisted[\s\S]*?window\.location\.reload\(\)/);
});

test("background model loading does not fail just because silent token refresh is temporarily unavailable", () => {
  assert.match(apiServiceSource, /optionalAuth \? await acquireApiTokenSilent\(\) : await acquireApiToken\(\)/);
  assert.match(apiServiceSource, /api\.get\('\/models', \{ vcsOptionalAuth: true \}\)/);
  assert.match(apiServiceSource, /api\.post\('\/models\/select',[\s\S]*?\{ vcsOptionalAuth: true \}\)/);
});

test("the current-config filename cannot push Save new outside its card", () => {
  assert.match(livePageSource, /className="min-w-0 flex-1"[\s\S]*?className="mt-0\.5 truncate text-xs/);
  assert.match(livePageSource, /className="h-8 shrink-0 whitespace-nowrap rounded-xl/);
});

test("GI keeps the deployed D25 login presentation while faculty uses its own layout", () => {
  assert.match(loginPageSource, /title = 'Login'/);
  assert.match(loginPageSource, /description = 'Welcome to LKCMedicine Lecture'/);
  assert.match(loginPageSource, /variant = 'lecture'/);
  assert.match(microsoftEntryPageSource, /variant === 'lecture'/);
  assert.match(microsoftEntryPageSource, /Sign in with your Microsoft account/);
  assert.match(appSource, /<LoginPage[\s\S]*?variant="faculty"[\s\S]*?title="Faculty Voice Assistant"/);
});

// Only the staff tools (Live Fast/TTS and Live MC) synthesise unsigned. Faculty
// and GI lectures must never appear in the exemption, and the gateway and Lambda
// lists must stay identical so one build never gets only half a conversation.
const STAFF_EXEMPT_ORIGINS = ['https://dfzrfr93t2ruf.cloudfront.net', 'https://d32nzk2gacfhag.cloudfront.net'];
function exemptOrigins(source) {
  const match = source.match(/^LIVE_AUTH_EXEMPT_ORIGINS=(.*)$/m);
  assert.ok(match, 'LIVE_AUTH_EXEMPT_ORIGINS must be set explicitly');
  return match[1].trim().split(',').map((origin) => origin.trim()).filter(Boolean).sort();
}

test("faculty has no backend auth exemption and uses a lecturer table", () => {
  for (const source of [stagingGatewayEnv, stagingLambdaEnv]) {
    const exempt = exemptOrigins(source);
    assert.deepEqual(exempt, [...STAFF_EXEMPT_ORIGINS].sort());
    for (const signedSite of ['faculty.lkcmedicine.org', 'd3k2rz0hqm8nxi', 'lectures.lkcmedicine.org', 'd25sg72wp8oj5g']) {
      assert.equal(exempt.some((origin) => origin.includes(signedSite)), false, `${signedSite} must stay signed`);
    }
  }
  assert.match(stagingGatewayEnv, /^LECTURER_TABLE_NAME=vcs-staging-lecturers$/m);
  for (const source of [stagingGatewayEnv, stagingLambdaEnv]) {
    assert.match(
      source,
      /^FACULTY_ENTRA_ALLOWED_EMAIL_DOMAINS=staff\.main\.ntu\.edu\.sg,assoc\.main\.ntu\.edu\.sg$/m,
    );
  }
});

test("public GI visitors bypass protected routes and cannot render the login page", () => {
  assert.match(
    appAuthGateSource,
    /if \(!config\.authEnabled\) return children;/,
  );
  assert.match(
    giAppSource,
    /path="\/login"[\s\S]*?config\.authEnabled[\s\S]*?<LoginPage \/>[\s\S]*?<Navigate to="\/" replace \/>/,
  );
});

test("a public build does not bootstrap Microsoft authentication", () => {
  assert.match(
    mainSource,
    /config\.authEnabled && isMsalAuthEnabled\(\)/,
  );
});

test("public search and lesson pages do not offer a nonfunctional sign-out action", () => {
  for (const source of [searchPageSource, lessonPageSource]) {
    assert.match(
      source,
      /config\.giAuthEnabled && auth\.isAuthenticated/,
    );
  }
});

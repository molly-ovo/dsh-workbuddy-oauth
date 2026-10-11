import z from "@deepseek-ai/schemastery";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
//#region src/identity.ts
/**
* Default desktop-app version claimed for the domestic region.
*
* A claim, not a measurement: the upstream has not been observed to branch on
* the specific value, only on the User-Agent being app-shaped rather than
* CLI-shaped. Kept equal to the reference implementation's constant so the
* outbound fingerprint matches what has been running in practice.
*/
const DEFAULT_CN_APP_VERSION = "5.5.6";
/** Default desktop-app version for the international region. */
const DEFAULT_GLOBAL_APP_VERSION = "5.5.2";
/**
* Whether a value is a version that may reach a header.
*
* Tolerates a prerelease suffix (`2.137.1-rc.1`); anything containing
* whitespace, CR or LF never passes, because the value is interpolated into an
* HTTP header and a newline there is a header-injection vector.
*/
function validVersion(value) {
	return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value);
}
/**
* The version to claim for one region, honouring configuration and validating
* it.
*
* An invalid configured value is **rejected, not coerced** — silently sending
* the default when the user asked for something else would hide their typo
* behind a request that appears to work.
*
* @throws Error - the configured version is not header-safe.
*/
function resolveAppVersion(region, config = {}) {
	const configured = config.appVersion;
	if (configured !== void 0 && configured !== "") {
		if (!validVersion(configured)) throw new Error(`配置的 appVersion 无法用作请求头：${JSON.stringify(configured)}（需形如 5.5.6）`);
		return configured;
	}
	return region === "global" ? DEFAULT_GLOBAL_APP_VERSION : DEFAULT_CN_APP_VERSION;
}
/**
* Resolve the full chat identity for one region.
*
* Never throws on a bad CLI version — an unusable optional token is dropped
* rather than failing the request, because the `CLI/…` segment is optional to
* the upstream while a failed message is not recoverable.
*
* @throws Error - the app version itself is unusable.
*/
function resolveChatIdentity(region, config = {}) {
	const clientVersion = resolveAppVersion(region, config);
	const cliVersion = config.cliVersion;
	if (cliVersion !== void 0 && cliVersion !== "" && validVersion(cliVersion)) return {
		clientVersion,
		cliVersion
	};
	return { clientVersion };
}
/**
* The identity every failure path converges on.
*
* Present so a caller missing its configuration still sends an app-shaped
* request rather than the CLI shape, which would fetch a different model
* roster.
*/
function fallbackChatIdentity(region) {
	return { clientVersion: region === "global" ? DEFAULT_GLOBAL_APP_VERSION : DEFAULT_CN_APP_VERSION };
}
/**
* Build the chat User-Agent for one region.
*
* @throws Error - either version is unusable; see {@link validVersion}.
*/
function chatUserAgent(identity, region) {
	if (!validVersion(identity.clientVersion)) throw new Error(`chat User-Agent 的版本不可用：${JSON.stringify(identity.clientVersion)}`);
	if (identity.cliVersion !== void 0 && !validVersion(identity.cliVersion)) throw new Error(`chat User-Agent 的 CLI 版本不可用：${JSON.stringify(identity.cliVersion)}`);
	const product = region === "global" ? "WorkBuddy AI" : "WorkBuddy";
	const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`];
	if (identity.cliVersion !== void 0) parts.push(`CLI/${identity.cliVersion}`);
	return parts.join(" ");
}
/**
* Build the App-shaped User-Agent for catalog requests.
*
* The product token has **no space** and no repetition: `WorkBuddyAI/<ver>` is
* the form measured to reach the App roster; the spaced form is rejected with
* 400/12403.
*
* @throws Error - the version is unusable.
*/
function appUserAgent(version) {
	if (!validVersion(version)) throw new Error(`catalog User-Agent 的版本不可用：${JSON.stringify(version)}`);
	return `WorkBuddyAI/${version}`;
}
//#endregion
//#region src/region.ts
/**
* Endpoint table.
*
* CN's `base` and `origin` are different domains on purpose — the upstream
* validates `Origin` against the web site while serving the API from the
* copilot host. Do not "tidy" these into one value. `loginBase` is a third host
* for the same reason; see {@link RegionEndpoints.loginBase}.
*/
function regionEndpoints(region) {
	return region === "global" ? {
		base: "https://www.workbuddy.ai",
		origin: "https://www.workbuddy.ai",
		loginBase: "https://www.workbuddy.ai",
		label: "WorkBuddy AI (国际版)"
	} : {
		base: "https://copilot.tencent.com",
		origin: "https://www.codebuddy.cn",
		loginBase: "https://www.workbuddy.cn",
		label: "WorkBuddy (国内版)"
	};
}
/**
* Infer the region from a credential's `domain` field.
*
* The upstream returns a bare domain (e.g. `workbuddy.ai`), so this matches on
* the suffix rather than equality.
*
* @param domain - Domain reported by the upstream credential.
* @returns The region that domain belongs to; defaults to `cn`.
*/
function regionOfDomain(domain) {
	const normalized = domain.trim().toLowerCase();
	return normalized === "workbuddy.ai" || normalized.endsWith(".workbuddy.ai") ? "global" : "cn";
}
/** Both regions, for iteration in status output. */
const ALL_REGIONS = ["cn", "global"];
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
* not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-workbuddy-oauth/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The upstream's "this effort value is not supported" codes, per region, as
* measured on each live endpoint. The sets stay separate so a code only ever
* widens detection for the endpoint it was measured on.
*
* - `invalid_reasoning_effort` — the China endpoint, measured 2026-09-11
*   (plan §4.2). Kept for `global` too as the spelling already in the wild.
* - `model_param_invalid` — the global endpoint, measured 2026-10-01. A
*   non-canonical value is answered `400` / `11133` with this code, which names
*   no field (`extError.param` is empty) rather than naming the effort.
*
* A generic code is readable here only because the baseline step has already
* proved the *same* request without `reasoning_effort` succeeds, leaving the
* sentinel as the only difference between the two attempts. That is also why it
* is *not* added to `cn`: that endpoint was measured answering the specific
* code, and accepting a generic one there would attribute beyond what was seen.
*
* Neither is a permanent protocol promise: anything unrecognized still degrades
* to `unknown` rather than to a capability conclusion.
*/
const INVALID_EFFORT_CODES = {
	cn: /* @__PURE__ */ new Set(["invalid_reasoning_effort"]),
	global: /* @__PURE__ */ new Set(["invalid_reasoning_effort", "model_param_invalid"])
};
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt, region) {
	const codes = INVALID_EFFORT_CODES[region];
	return attempt.status === 400 && attempt.errorCode !== void 0 && codes.has(attempt.errorCode);
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
* endpoint's rejection vocabulary is read; it defaults to `cn`, matching the
* China app that was the first target.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	const region = options.region ?? "cn";
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt, region)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt, region)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/upstream.ts
/**
* WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
* model catalog, and credit balance.
*
* The wire behavior is ported from `dsh-workbuddy-connect` (MIT), itself ported
* from Sliverkiss/workbuddy2api (MIT), whose Go implementation is battle-tested
* against the real endpoint. The differences from connect are confined to the
* seams: this client takes its credential from {@link ./credentials.ts}
* (obtained by this plugin's own OAuth flow) and its outbound identity from
* configuration ({@link ./identity.ts}) rather than from an installed desktop
* app.
*
* @module dsh-workbuddy-oauth/upstream
*/
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* Display name for the single synthetic row the enterprise endpoint produces.
*
* The endpoint reports one cycle quota, not the personal endpoint's list of
* named packages, so the card's "by package" table has exactly one row.
*/
const enterprisePackageName = "enterprise";
/**
* Field names and value types of a response document, for diagnostics.
*
* Names and `typeof` only. This string ends up in the status route and then in
* the browser, and the response describes the account's own usage; the values
* themselves must never travel. Only the document and its `data` member are
* described, so the output stays small.
*/
function describeShape(document) {
	if (typeof document !== "object" || document === null || Array.isArray(document)) return typeof document;
	const record = document;
	const at = (source) => {
		const keys = Object.keys(source).slice(0, 24);
		return keys.length === 0 ? "(empty)" : keys.map((key) => `${key}:${typeof source[key]}`).join(", ");
	};
	const top = `top-level { ${at(record)} }`;
	const data = record["data"];
	if (typeof data !== "object" || data === null || Array.isArray(data)) return top;
	return `${top}; data { ${at(data)} }`;
}
/** Shared CLI-form User-Agent for refresh and the CN catalog; chat and probe present the configured identity (see ./identity.ts). */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/**
* Insufficient-credit markers, ASCII lowercase plus the original Chinese.
*
* Measured 2026-09-30 on a genuinely exhausted CN account: the upstream answers
* **HTTP 429** with `{"error":{"data":{"code":14018,"msg":"额度已用尽，…购买加量包…"}}}`
* — not a 402, and the wording is 「额度**已**用尽」, which the earlier list
* (「额度用尽」) did not match, so exhaustion was being classified as `soft_rate`
* (transient rate limiting) instead of `hard_credit` (out of credit). Both the
* marker set and the classification order account for that.
*/
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"credits exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"额度已用尽",
	"额度已用完",
	"额度用尽",
	"额度不足",
	"额度已不足",
	"积分不足",
	"积分已用完",
	"积分用完",
	"余额不足",
	"没有积分"
];
/**
* Upstream business codes that mean "out of credit" whatever the HTTP status.
*
* `14018` is the measured exhaustion code ("额度已用尽"). It travels inside a
* nested `error.data.code`, so it is matched against the body text like the
* markers rather than parsed out — the body is already the classifier's input.
*/
const HARD_CREDIT_CODES = ["14018"];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some catalog
* rows report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/**
* Parse the upstream `tags` / `credits` fields into billing metadata.
*
* @param wrapped - one catalog row.
* @param extraTags - badge tags recovered from another document, merged in
* after the row's own. The `/v3/config` product document carries the roster
* but no `badge:*` tags; those live only in the console catalog, so the CN
* refresh reads both and joins them here (see `fetchPromoBadges`).
*/
function resolveUpstreamBilling(wrapped, extraTags) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = [...Array.isArray(wrapped["tags"]) ? wrapped["tags"] : [], ...extraTags ?? []];
	for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "" && !badges.includes(label)) badges.push(label);
	}
	const multiplier = normalizeCredits(credits);
	const free = multiplier !== void 0 && /^x?0\.0+$/u.test(multiplier);
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	} };
}
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/**
* Classify an upstream failure from its HTTP status and body excerpt.
*
* **Credit is checked before the status-code fallbacks, deliberately.** The
* upstream reports an exhausted account as HTTP 429 with code 14018, and 429
* otherwise means rate limiting — but "no credit" is permanent until the user
* pays, while "slow down" clears on its own. Treating the former as the latter
* makes the pool retry a dead account forever. The body markers are therefore
* consulted for every status, not only after 402.
*/
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	if (status === 401) return "session_dead";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const code of HARD_CREDIT_CODES) if (body.includes(code)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Extract a user-facing error message from an upstream JSON response body.
* Prefers WorkBuddy's localized `displayMsg.zh` / `displayMsg.en`, falling back to `msg`.
*/
function extractDisplayErrorMessage(body) {
	const trimmed = body.trim();
	if (!trimmed.startsWith("{")) return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		const obj = parsed;
		const displayMsg = obj["displayMsg"];
		if (typeof displayMsg === "object" && displayMsg !== null && !Array.isArray(displayMsg)) {
			const localized = displayMsg;
			if (typeof localized["zh"] === "string" && localized["zh"].trim() !== "") return localized["zh"].trim();
			if (typeof localized["en"] === "string" && localized["en"].trim() !== "") return localized["en"].trim();
		}
		if (typeof obj["msg"] === "string" && obj["msg"].trim() !== "") return obj["msg"].trim();
	} catch {}
}
/**
* Region for a login domain.
*
* Kept as a thin local alias so the ported call sites stay unchanged; the
* definition lives in {@link ./region.ts} so the plugin has exactly one
* domain-to-region rule.
*/
function regionOf(domain) {
	return regionOfDomain(domain);
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/**
* Chat request headers, including the X-No-* conventions the official CLI uses.
*
* `userAgent` and `clientVersion` carry the same resolved desktop identity for
* chat and probe requests. Refresh shares `commonHeaders` but never this
* override, so the two paths cannot drift into each other.
*/
function chatHeaders(credential, userAgent, clientVersion) {
	return {
		...commonHeaders(credential),
		"User-Agent": userAgent,
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Name": "WorkBuddy",
		"X-IDE-Version": clientVersion,
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders$1(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
* force `stream: true` (the upstream rejects non-streaming), flatten
* `tool_choice` (the upstream's field is a string; object forms return 400),
* and rewrite `developer` messages as `system`.
*
* The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
* `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
* upstream rejects that role with HTTP 400 code 11128 ("Illegal API
* invocation from an unapproved channel"). Rewriting to `system` is the
* compatible spelling the upstream accepts.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0,
		document
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*
* One instance is *per variant*: the international provider needs its own
* catalog source, UA version, and probe differences, and keeping them on the
* instance avoids passing a variant through every call signature.
*/
var WorkBuddyUpstreamClient = class {
	/** Outbound identity configuration; see {@link ./identity.ts}. */
	identity;
	/**
	* Resolves the App-shaped UA version for international catalog requests.
	* Injectable so tests never read the real filesystem.
	*/
	resolveAppVersion;
	/** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
	resolveChatIdentity;
	/** Provenance of the most recent successful catalog fetch, for the card. */
	lastCatalog;
	constructor(options = {}) {
		this.identity = options.identity ?? {};
		this.resolveAppVersion = options.resolveAppVersion ?? (async () => ({
			version: resolveChatIdentity("cn", this.identity).clientVersion,
			source: this.identity.appVersion !== void 0 && this.identity.appVersion !== "" ? "config" : "fallback"
		}));
		this.resolveChatIdentity = options.resolveChatIdentity ?? (async (region) => resolveChatIdentity(region, this.identity));
	}
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		const region = regionOf(credential.domain);
		let identity;
		let userAgent;
		try {
			identity = await this.resolveChatIdentity(region);
			userAgent = chatUserAgent(identity, region);
		} catch {
			identity = fallbackChatIdentity(region);
			userAgent = chatUserAgent(identity, region);
		}
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent, identity.clientVersion),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: region === "global" ? prepareInternationalChatBody(bodyJson) : bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders$1(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* GET the personal model catalog.
	*
	* Both variants read `/v3/config`, the product document the desktop product
	* itself fetches. CN used to read `/console/enterprises/personal/models`
	* (the console catalog) instead, and that was why its model list drifted
	* from the desktop App's selector: the console document lags the product
	* one, and the product roster itself churns day to day (`auto`,
	* `kimi-k3-1`, `minimax-m3` have each appeared and disappeared within a
	* week).
	*
	* What distinguishes the two variants here is the User-Agent, not the path:
	* the gateway splits `/v3/config` by client identity, and the split is
	* load-bearing. A CLI-shaped UA yields the CLI's roster — the chat models
	* this plugin serves — while an App-shaped UA yields the App's internal
	* roster. CN keeps the CLI UA it sends for chat, so the catalog it
	* advertises is exactly the one its own requests can use. The international
	* variant has no CLI identity, so it keeps the App-shaped UA.
	*
	* Membership is the `cli` roster intersected with the usable rows (see
	* {@link parseModelCatalog}); the promo badges the product document does
	* not carry are merged in from a best-effort console read — see
	* {@link fetchPromoBadges}.
	*
	* Responses are unwrapped and classified the same way — `readEnvelope` plus
	* `envelopeError` — so an expired session or exhausted credit is reported as
	* such rather than as a generic catalog failure.
	*/
	async fetchModels(credential, signal) {
		const international = regionOf(credential.domain) === "global";
		const appVersion = international ? await this.resolveAppVersion() : void 0;
		const response = await fetch(`${chatBase(credential)}/v3/config`, {
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				Accept: "application/json",
				Origin: originReferer(credential),
				Referer: `${originReferer(credential)}/`,
				...international ? {
					"X-Requested-With": "XMLHttpRequest",
					"X-Product": "SaaS"
				} : {},
				"User-Agent": appVersion === void 0 ? CLIENT_UA : appUserAgent(appVersion.version)
			},
			signal: signal === void 0 ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)])
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const models = parseModelCatalog(isObject(envelope.data) ? envelope.data : "models" in envelope.document || "agents" in envelope.document ? envelope.document : {}, international, international ? void 0 : await this.fetchPromoBadges(credential, signal));
		this.lastCatalog = {
			fetchedAtMs: Date.now(),
			source: international ? "workbuddy-ai:app" : "workbuddy:cli",
			...appVersion === void 0 ? {} : { appVersion }
		};
		return models;
	}
	/**
	* Read the console catalog's promotional tags, by model id.
	*
	* `/v3/config` carries no `badge:<label>:<color>` tags — the discount labels
	* the cards render (`限时免费`, `夜间折扣`, …) live only in
	* `/console/enterprises/personal/models`. Since the roster now comes from
	* the product document, those tags are read from the console one in a
	* second request and merged by id.
	*
	* Best-effort by construction: a badge is a label on a price, so failing to
	* read this document must not fail a catalog refresh. Every failure —
	* network, envelope, an unreadable body — returns undefined, and the models
	* simply ship without badges.
	*/
	async fetchPromoBadges(credential, signal) {
		try {
			const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
				headers: {
					Authorization: `Bearer ${credential.accessToken}`,
					Accept: "application/json",
					Origin: originReferer(credential),
					Referer: `${originReferer(credential)}/`,
					"User-Agent": CLIENT_UA
				},
				signal: signal === void 0 ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)])
			});
			if (!response.ok) return void 0;
			const envelope = await readEnvelope(response);
			const data = isObject(envelope.data) ? envelope.data : envelope.document;
			const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
			const badges = /* @__PURE__ */ new Map();
			for (const model of rawModels) {
				if (!isObject(model)) continue;
				const id = typeof model["id"] === "string" ? model["id"] : "";
				if (id === "") continue;
				const tags = Array.isArray(model["tags"]) ? model["tags"].filter((tag) => typeof tag === "string" && tag.toLowerCase().startsWith(BADGE_PREFIX)) : [];
				if (tags.length > 0) badges.set(id, tags);
			}
			return badges.size === 0 ? void 0 : badges;
		} catch {
			return;
		}
	}
	/**
	* POST the billing endpoint for the aggregated remaining credit.
	*
	* Two upstream shapes, chosen by account type:
	*
	* - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
	*   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
	*   cycle quota. The personal endpoint serves these accounts an empty
	*   `Accounts` list, which the card then renders as "0 credit" — a wrong
	*   number rather than a visible failure (issue #31).
	* - **Everyone else** keeps the personal endpoint unchanged.
	*
	* The region gate is load-bearing: the enterprise endpoint is unverified for
	* the global region, so an international credential that happens to carry an
	* `enterpriseId` must stay on the measured personal path instead of being
	* moved onto an unmeasured one.
	*/
	async fetchCredits(credential) {
		if (regionOf(credential.domain) === "cn" && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") return await this.fetchEnterpriseCredits(credential);
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize")
			});
		}
		return {
			total,
			accounts
		};
	}
	/**
	* CN enterprise credit read: a single cycle quota instead of a package list.
	*
	* Verified against the WorkBuddy desktop app (`app.asar`,
	* `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
	* body is an empty object and the account identity travels only in the
	* headers. The two official call sites disagree on the field spelling
	* (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
	*
	* A body carrying no recognisable quota field is a hard error rather than a
	* zero. Rendering `0` for "we did not understand the answer" is exactly how
	* issue #31 stayed invisible while users saw a plausible wrong number.
	*
	* The error names fields and types only: it reaches the browser, and the
	* response body may describe the account's usage.
	*/
	async fetchEnterpriseCredits(credential) {
		const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const sources = [];
		for (const candidate of [envelope.data, envelope.document]) {
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
			const record = candidate;
			if (typeof record["data"] === "object" && record["data"] !== null && !Array.isArray(record["data"])) sources.push(record["data"]);
			sources.push(record);
		}
		const numberAt = (source, key) => typeof source[key] === "number" ? source[key] : void 0;
		let limit;
		let used;
		let resetTime;
		for (const source of sources) {
			const candidate = numberAt(source, "limitNum") ?? numberAt(source, "limit_num");
			if (candidate === void 0) continue;
			limit = candidate;
			used = numberAt(source, "credit") ?? numberAt(source, "used_num");
			if (typeof source["cycleResetTime"] === "string" && source["cycleResetTime"] !== "") resetTime = source["cycleResetTime"];
			break;
		}
		if (limit === void 0) throw new Error(`workbuddy enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num; received ${describeShape(envelope.document)})`);
		if (limit === -1) return {
			total: 0,
			accounts: [{
				packageName: enterprisePackageName,
				remain: 0,
				size: 0,
				unlimited: true
			}],
			unlimited: true,
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
		if (used === void 0) throw new Error(`workbuddy enterprise billing response carried a quota limit but no recognised usage field (expected credit/used_num alongside limitNum/limit_num; received ${describeShape(envelope.document)})`);
		let remain = limit - used;
		if (remain < 0) remain = 0;
		return {
			total: remain,
			accounts: [{
				packageName: enterprisePackageName,
				remain,
				size: limit
			}],
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
	}
	/**
	* One probe request: a real streaming chat call carrying the effort under
	* test.
	*
	* Shares `chatHeaders` with the normal chat path on purpose — the plan
	* forbids probing through anything but the plugin's own credential handling,
	* so a result describes what a real message would experience.
	*
	* The caller aborts as soon as a parseable event arrives; the body is never
	* assembled into an answer. `reasoning_effort` is omitted entirely (rather
	* than sent empty) when `effort` is undefined, so the baseline case is a
	* genuinely bare request.
	*
	* Two international differences, both measured on 2026-09-11:
	*
	* - The gateway requires a leading `system` message (400/11128 otherwise), so
	*   one is prepended for the global region only.
	* - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
	*   with 400/11133 `integer_below_min_value`), so the international probe asks
	*   for a slightly larger minimum. This is a floor the plugin must clear, not
	*   evidence about any model's effort support: a model still refusing that
	*   minimum is reported as an incompatible request, never as "effort
	*   unsupported", and the ceiling is never raised further to force an answer.
	*/
	async probeEffort(credential, model, effort, signal) {
		const international = regionOf(credential.domain) === "global";
		let identity;
		let userAgent;
		try {
			identity = await this.resolveChatIdentity(international ? "global" : "cn");
			userAgent = chatUserAgent(identity, international ? "global" : "cn");
		} catch {
			identity = fallbackChatIdentity(international ? "global" : "cn");
			userAgent = chatUserAgent(identity, international ? "global" : "cn");
		}
		const payload = {
			model,
			stream: true,
			messages: [...international ? [{
				role: "system",
				content: INTERNATIONAL_SYSTEM_PROMPT
			}] : [], {
				role: "user",
				content: PROBE_PROMPT
			}],
			max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : 1
		};
		if (effort !== void 0) payload["reasoning_effort"] = effort;
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent, identity.clientVersion),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			return {
				status: response.status,
				streamed: false,
				...errorCodeOf(text)
			};
		}
		const streamed = await readFirstEvent(response);
		return {
			status: response.status,
			streamed
		};
	}
};
/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const extError = parsed["extError"];
			if (typeof extError === "object" && extError !== null && !Array.isArray(extError)) {
				const code = extError["code"];
				if (typeof code === "string") return {
					errorCode: code,
					detail: code
				};
			}
		}
	} catch {}
	return { detail: text.slice(0, 200) };
}
/**
* Consume just enough of a streaming response to know it really streams.
*
* Returns true on the first chunk containing a data line. Cancels the body
* afterwards; a stream that ends or errors before that counts as not streamed,
* because an empty 200 is not evidence the effort was accepted.
*/
async function readFirstEvent(response) {
	const body = response.body;
	if (body === null) return false;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (decoder.decode(value, { stream: true }).includes("data:")) return true;
		}
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
/**
* Parse either response shape after its envelope has been checked.
*
* Membership is the `cli` agent's roster, intersected with the rows that are
* usable: the roster is what the client identity this plugin presents is
* allowed to chat with, and joining rather than trusting it outright drops
* both ids the roster has retired and rows the document lists but cannot
* serve (no row, `disabled: true`, or non-positive caps all drop out here —
* a published-but-unservable id must never reach the picker).
*
* @param data - the unwrapped catalog/product document.
* @param international - whether it is the international product document, whose
* rows carry window objects and promotions.
* @param promoBadges - badge tags by model id, read from the console document,
* which is the only one that carries them.
*/
function parseModelCatalog(data, international = false, promoBadges) {
	const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
	const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
	let cliIds;
	for (const agent of agents) if (typeof agent === "object" && agent !== null) {
		const wrapped = agent;
		if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
			cliIds = wrapped["models"].filter((id) => typeof id === "string");
			break;
		}
	}
	if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy model catalog lists no cli agent models");
	const byId = /* @__PURE__ */ new Map();
	for (const model of rawModels) {
		if (typeof model !== "object" || model === null) continue;
		const wrapped = model;
		const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
		if (id === "" || wrapped["disabled"] === true) continue;
		const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
		const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
		if (input <= 0 || output <= 0) continue;
		byId.set(id, {
			id,
			name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
			contextWindow: international && isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? wrapped["contextWindow"]["defaultLength"] : input,
			...international ? {
				...isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? { defaultContextWindow: wrapped["contextWindow"]["defaultLength"] } : {},
				maxInputTokens: input,
				supportedContextWindows: isObject(wrapped["contextWindow"]) && Array.isArray(wrapped["contextWindow"]["supportedLengths"]) ? wrapped["contextWindow"]["supportedLengths"].filter(positive) : [],
				promotions: parsePromotions(data["modelPromotions"], id)
			} : {},
			maxTokens: output,
			supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
			...resolveUpstreamReasoning(wrapped),
			...resolveUpstreamBilling(wrapped, promoBadges?.get(id))
		});
	}
	const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
	if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
	return models;
}
/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value, model) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isObject(item) || item["enabled"] !== true) return [];
		const modelIds = item["modelIds"];
		if (!Array.isArray(modelIds) || !modelIds.includes(model)) return [];
		const schedule = item["schedule"];
		const discount = item["discount"];
		const badge = item["badge"];
		if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return [];
		if (discount["displayMode"] !== "replace") return [];
		const start = typeof schedule["validFrom"] === "string" ? Date.parse(schedule["validFrom"]) : NaN;
		const end = typeof schedule["validUntil"] === "string" ? Date.parse(schedule["validUntil"]) : NaN;
		const factor = discount["factor"];
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
		if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) return [];
		return [{
			start,
			end,
			factor,
			label: typeof badge["label"] === "string" ? badge["label"] : "",
			priority: typeof item["priority"] === "number" && Number.isFinite(item["priority"]) ? item["priority"] : 0
		}];
	});
}
/**
* Re-evaluate a model's promotion against the current time.
*
* Promotions are time-boxed, and the catalog they arrive in is cached for the
* life of the process. Frozen at parse time, a cached "Free now" would keep
* claiming a discount after `validUntil` had passed, and would keep showing the
* pre-discount rate as the discounted one. Re-deriving on every read means the
* badge disappears on its own and the rate reverts, with no refresh needed.
*
* Non-destructive: the model's own `credits` and `badges` are the base, and the
* promotion is layered onto a copy. A model with no live promotion is returned
* as-is, so the common case allocates nothing.
*/
function modelWithCurrentPromotion(model, now = Date.now()) {
	if (model.promotions === void 0 || model.promotions.length === 0) return model;
	const promotion = [...model.promotions].sort((a, b) => b.priority - a.priority).find((candidate) => now >= candidate.start && now < candidate.end);
	if (promotion === void 0) {
		if (!(model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0 || model.promotions.some((candidate) => candidate.factor !== 1))) return model;
		return {
			...model,
			billing: {
				free: false,
				rateUnknown: true
			}
		};
	}
	const rate = normalizeCredits(model.billing?.credits);
	const original = rate !== void 0 && rate.startsWith("x") ? Number(rate.slice(1)) : NaN;
	if (promotion.factor !== 0 && !Number.isFinite(original)) return model;
	const value = promotion.factor === 0 ? 0 : original * promotion.factor;
	return {
		...model,
		billing: {
			...model.billing,
			credits: `x${value.toFixed(2)}`,
			free: value === 0,
			badges: [...model.billing?.badges ?? [], ...promotion.label === "" ? [] : [promotion.label]]
		}
	};
}
/**
* Apply the international endpoint's extra chat requirement: the first message
* must be a system prompt.
*
* The international gateway rejects a body whose first message is not `system`
* with HTTP 400 code 11128 ("first message is not system prompt"). Note that
* the *same* code means something else on the CN endpoint — there it reports a
* rejected `developer` role — so the two are never branched on by code alone.
*
* The added prompt is deliberately empty of user content and prepended, never
* merged: existing messages keep their order and wording. A body that is not a
* JSON object is returned unchanged, exactly as {@link prepareChatBody} does,
* so this is safe to run over an already-prepared-or-not body.
*/
function prepareInternationalChatBody(source) {
	const prepared = prepareChatBody(source);
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return prepared;
	}
	if (!isObject(body)) return prepared;
	dropUnsupportedEffort(body);
	const messages = body["messages"];
	if (!Array.isArray(messages)) return JSON.stringify(body);
	const first = messages[0];
	if (isObject(first) && first["role"] === "system") return JSON.stringify(body);
	messages.unshift({
		role: "system",
		content: INTERNATIONAL_SYSTEM_PROMPT
	});
	return JSON.stringify(body);
}
/**
* Remove the adapter's own `off` effort spelling from the **international** wire.
*
* `thinkingLevelMap.off` is pinned to the literal `'off'` for models that
* declare `canDisableThinking`, so that the level stays selectable. pi-ai
* sends that value for any request carrying no explicit level, and the
* international endpoint rejects it on the GPT family with HTTP 400 `11133` /
* `extError.param === 'reasoning.effort'` (issue #49). Omission is the only
* form measured good on every such model; a literal `'none'` is *not* a safe
* substitute — accepted by the GPT-5.6 family and GLM, rejected by
* `gpt-6-astra`.
*
* Consequences, stated honestly: the international picker still offers Off,
* but selecting it now means "the field is omitted" — the model's actual
* behaviour is decided upstream and is *not* guaranteed to disable thinking
* or to match the catalog's `defaultEffort`. Declared spellings
* (`low`/`medium`/`high`/`xhigh`/`max`) and an explicit `none` pass through
* untouched. The CN variant is deliberately unaffected: its endpoint has
* accepted this spelling in every measurement so far, and keeping its wire
* unchanged is a scope decision, not a claim about that endpoint's future.
*/
function dropUnsupportedEffort(obj) {
	if (obj["reasoning_effort"] === "off") delete obj["reasoning_effort"];
}
/**
* The system prompt injected when the international endpoint receives a body
* with none.
*
* Minimal on purpose: it exists to satisfy a gateway precondition, not to
* steer the model. The plugin is not the place to invent a persona, and the
* normal path never reaches this — pi-ai already sends the harness's system
* prompt, so this only covers a caller that omitted one.
*/
const INTERNATIONAL_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
* Output ceiling for an international probe request.
*
* Above the smallest value that the strictest observed model accepts (the
* GPT-5.6 family rejects `1` with 11133), while still being far too small to
* produce a real answer. See {@link WorkBuddyUpstreamClient.probeEffort}.
*/
const INTERNATIONAL_PROBE_MAX_TOKENS = 16;
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points the way `dsh-codex-connect` assembles its Codex route.
*
* @module dsh-workbuddy-oauth/adapter
*/
/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER$1 = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS$1 = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-oauth: the workbuddy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Translate the request-image contract across the two attachment-service
* generations a link-installed plugin can straddle.
*
* A `link:` install resolves its platform imports from the *repository's*
* node_modules (Node follows the symlink's real path), so this adapter always
* runs against the pi-ai it was built with — while the attachment service
* comes from the host. Those two generations disagree on what
* `readImageRequest(ref, policyOrTarget)` receives:
*
* - dsh-attachment-local ≤0.1.5: a route policy `{ maxPixels, maxBytes }`,
*   and `validatePolicy` throws `Image request maxPixels must be a positive
*   integer.` when `maxPixels` is missing.
* - 0.1.6+: a per-image target `{ width, height, maxBytes }` with no
*   `maxPixels` at all, validated by `validateTarget`.
*
* A 0.1.6-built pi-ai on a 0.1.5 host therefore hands the old store a target
* the old store rejects, and every image-bearing request fails before it is
* sent. The wrapper below fills the route's own pixel budget into a target
* that lacks it: the 0.1.5 store then computes the same dimensions pi-ai's
* budget already chose, and a 0.1.6 store ignores the extra key.
*/
function withLegacyImageBudget(store) {
	return new Proxy(store, { get(target, property, receiver) {
		if (property === "imageHostPath") return target.imageHostPath.bind(target);
		if (property !== "readImageRequest") return Reflect.get(target, property, receiver);
		return (...args) => {
			const [ref, policy, signal] = args;
			const present = policy?.maxPixels;
			const withPixels = Number.isSafeInteger(present) && present > 0 ? policy : {
				...policy,
				maxPixels: REQUEST_IMAGE_BUDGETS.requestImagePixelBudget
			};
			return target.readImageRequest(ref, withPixels, signal);
		};
	} });
}
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* Append the billing rate to one model's display name.
*
* The rate AND the declared promo badges ride the *name* alone: since DSH
* 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
* `description` is no longer read there at all (the 0.1.1-era client rendered
* it, which is why the badges used to be visible in the seat). The `/model`
* popup renders the name too, so a separate `description` copy would either
* duplicate (rate) or vanish (badges) depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/**
* The catalog display suffix: the billing rate followed by the declared promo
* badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
* The badge labels are the upstream's own spellings and the host seam has no
* locale service, so non-Chinese UIs see them verbatim — accepted until the
* picker grows a localized badge slot.
*/
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows without a declared set (the older
*    `{effort, summary}` shape) normally get no control at all — their
*    selectable set is client-side knowledge the catalog does not carry, and
*    the desktop app differs per model there. If the user authorized a probe
*    and it established that the upstream *validates* the parameter, the
*    verified spellings are offered.
*
* A `non-validating` observation deliberately yields no control: the upstream
* accepts values that cannot exist (measured on `glm-5.2`), so every per-level
* acceptance it produced would be a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*/
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	if (declared !== void 0 && declared.length > 0) return {
		reasoning: true,
		thinkingLevelMap: thinkingLevelMap(declared, reasoning, true)
	};
	if (observed?.validation === "validating" && observed.efforts.length > 0) return {
		reasoning: true,
		thinkingLevelMap: thinkingLevelMap(observed.efforts, reasoning, false)
	};
	if (reasoning.defaultEffort !== void 0) return {
		reasoning: true,
		thinkingLevelMap: thinkingLevelMap([reasoning.defaultEffort], reasoning, false)
	};
	return { reasoning: false };
}
/**
* Build the pi-ai `thinkingLevelMap` for one model.
*
* Every level is written explicitly — `null` for unsupported — rather than left
* absent, because pi-ai reads an *absent* low/medium/high key as "use the
* provider default" and only filters a level when it maps to `null`. A partial
* map would therefore re-introduce the levels this function means to hide.
*/
function thinkingLevelMap(efforts, reasoning, declared) {
	return {
		off: declared && reasoning.canDisableThinking === true ? "off" : null,
		minimal: null,
		low: efforts.includes("low") ? "low" : null,
		medium: efforts.includes("medium") ? "medium" : null,
		high: efforts.includes("high") ? "high" : null,
		xhigh: efforts.includes("xhigh") ? "xhigh" : null,
		max: efforts.includes("max") ? "max" : null
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed, providerId = WORKBUDDY_PROVIDER$1) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: {
			maxTokensField: "max_tokens",
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter"
		}
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createWorkBuddyAdapter(options) {
	const { shim, store, catalog, resolveAttachments, resolveImageAccess, observe, hidden } = options;
	const providerId = options.providerId ?? "workbuddy";
	const displayName = options.displayName ?? "WorkBuddy";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS$1,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-oauth retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, hidden ?? (() => []), {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments: () => {
				const store = resolveAttachments();
				return store === void 0 ? void 0 : withLegacyImageBudget(store);
			} },
			...resolveImageAccess === void 0 ? {} : { resolveImageAccess }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	hidden;
	constructor(catalog, hidden, options) {
		super(options);
		this.catalog = catalog;
		this.hidden = hidden;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const hidden = new Set(this.hidden());
		return models.flatMap((model) => {
			if (hidden.has(model.id)) return [];
			const info = this.infoFor(model.id);
			if (info === void 0) return [model];
			return [{
				...model,
				name: withCatalogDisplay(model.name, info)
			}];
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/catalog.ts
/**
* WorkBuddy model catalog: a static fallback list captured from the live
* endpoint, replaced by the upstream's dynamic answer once it loads.
*
* @module dsh-workbuddy-oauth/catalog
*/
/**
* Static CLI models observed on the CN endpoint (re-verified against the live
* `/v3/config` document 2026-09-23, including the thinking-effort and billing
* metadata). The upstream refresh replaces this list at startup; it exists so
* the provider registers with a usable catalog even while the first fetch is
* in flight or offline.
*
* The list tracks the `cli` agent's model roster exactly — the 16 models it
* offered that day. The roster churns quickly (`auto`, `kimi-k3-1`,
* `minimax-m3` each appeared or vanished within days, and a competing patch's
* 2026-09-22 snapshot named three ids that were gone a day later), so this
* table is a boot-time placeholder, never a promise: the live fetch
* intersects the day's roster with the document's usable rows, and
* `tests/upstream.spec.ts` pins this table to the same parse so the two
* cannot drift apart silently. Reasoning metadata is verbatim from the live
* document, and the `free` flag follows the normalized `x0.00` credits
* marker.
*
* Deliberately NOT baked in: promotional badges. `限时免费` and friends are
* dynamic console-side promotions with no reliable validity window, so a
* static table would keep them alive long after the offers end. The live
* refresh merges the day's badges best-effort from the console document (see
* `fetchPromoBadges` in upstream.ts); until then the rows simply ship
* without them.
*/
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.29 credits",
			free: false
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00 credits",
			free: true
		}
	},
	{
		id: "hy3-x",
		name: "Hy3-X",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.05 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.03 credits",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.06 credits",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.71 credits",
			free: false
		}
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.25 credits",
			free: false
		}
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax-M2.7",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.19 credits",
			free: false
		}
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.8-preview",
		name: "Kimi-K2.8-Preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.77 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.57 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.51 credits",
			free: false
		}
	}
];
/**
* Static CLI models for the international endpoint, captured 2026-09-11 from
* the App-form `/v3/config` document (the 20 ids of its `cli` agent, in order).
*
* Same purpose and same discipline as {@link FALLBACK_WORKBUDDY_MODELS}: it
* covers the window before the first successful fetch and an offline start,
* and it is deliberately *not* a promise about the upstream's current state.
* Reasoning metadata is verbatim from that snapshot. No promo badge is baked
* in: promotions are time-boxed (`modelPromotions` carries `validFrom`/
* `validUntil`), so hard-coding a "Free now" label would keep claiming a
* discount the upstream may have already ended.
*/
const FALLBACK_WORKBUDDY_AI_MODELS = [
	{
		id: "default-model",
		name: "Auto",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: { free: false }
	},
	{
		id: "fast-model",
		name: "Fast",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.34",
			free: false
		}
	},
	{
		id: "balanced-model",
		name: "Balanced",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.59",
			free: false
		}
	},
	{
		id: "primary-model",
		name: "Primary",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "deep-model",
		name: "Deep",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: {
			credits: "x3.33",
			free: false
		}
	},
	{
		id: "hy4-preview-f",
		name: "Hy4 preview",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 4e5,
		defaultContextWindow: 4e5,
		supportedContextWindows: [4e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x6.67",
			free: false
		}
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x3.47",
			free: false
		}
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x1.39",
			free: false
		}
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.14",
			free: false
		}
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.65",
			free: false
		}
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.25",
			free: false
		}
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 65536,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.99",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high", "xhigh"],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52",
			free: false
		}
	}
];
/**
* Mutable catalog shared by the shim's `/v1/models` and the adapter.
*
* Visibility is separate from content. A variant whose app has no credentials
* must expose *no* models rather than a fallback roster: the DSH model picker
* drops an empty group, so an empty catalog is exactly how a provider hides
* without touching registration. Serving the fallback to a signed-out user
* instead offers models that can only fail (`store.resolve()` throws on the
* first message), which is worse than showing nothing.
*
* The flag defaults to visible so a directly-constructed catalog behaves as it
* always has; the plugin runtime applies the credential gate.
*/
var WorkBuddyCatalog = class {
	models;
	visible = true;
	useMaximumContextWindow = false;
	hiddenModels = /* @__PURE__ */ new Set();
	constructor(initial = FALLBACK_WORKBUDDY_MODELS) {
		this.models = initial;
	}
	/**
	* Current selectable entries; empty while the variant has no usable
	* credential. Hidden ids are dropped, so this is what the adapter and the
	* model picker read.
	*/
	current() {
		if (!this.visible) return [];
		return this.roster().filter((model) => !this.hiddenModels.has(model.id));
	}
	/**
	* The full roster, without the hidden filter.
	*
	* Distinct from {@link current} so the settings card can render *every* model
	* — including the ones the user hid — with its checkbox un-ticked. Hiding a
	* model is only reversible if the card can still see the hidden row to
	* un-check it, and a roster already filtered down to the visible ids leaves
	* nothing to click. The adapter and picker keep reading `current()`; only the
	* card's visibility list uses this wider view.
	*
	* Empty while the variant has no usable credential, exactly like `current()`.
	*/
	roster() {
		if (!this.visible) return [];
		return this.models.map((model) => this.display(model));
	}
	/** One entry with promotion and context-window selection applied, for display. */
	display(model) {
		const current = modelWithCurrentPromotion(model);
		const maximum = current.supportedContextWindows === void 0 ? void 0 : Math.max(...current.supportedContextWindows);
		return this.useMaximumContextWindow && maximum !== void 0 && maximum > current.contextWindow ? {
			...current,
			defaultContextWindow: current.defaultContextWindow ?? current.contextWindow,
			contextWindow: maximum
		} : current;
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
	/** Whether this variant's models are exposed at all. */
	isVisible() {
		return this.visible;
	}
	/**
	* Show or hide the whole catalog. Returns whether the value changed, so the
	* caller can skip an invalidation that would re-render an identical list.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
	}
	/** Whether the largest declared window is selected (see {@link setUseMaximumContextWindow}). */
	isUsingMaximumContextWindow() {
		return this.useMaximumContextWindow;
	}
	/** Select the largest declared international window where the upstream offers one. */
	setUseMaximumContextWindow(useMaximum) {
		if (this.useMaximumContextWindow === useMaximum) return false;
		this.useMaximumContextWindow = useMaximum;
		return true;
	}
	/**
	* Replace the hidden-model set for this region.
	*
	* Returns whether the set changed, so the caller can skip invalidating the
	* adapter when the toggle was a no-op. Hidden models stay hidden even when the
	* roster is later replaced by a catalog refresh: the rule is about ids, not
	* about the rows that happened to be present when it was set.
	*/
	setHiddenModels(ids) {
		const next = new Set(ids);
		if (next.size === this.hiddenModels.size && [...next].every((id) => this.hiddenModels.has(id))) return false;
		this.hiddenModels = next;
		return true;
	}
	/** The model ids currently hidden, for the status document. */
	hiddenModelIds() {
		return [...this.hiddenModels];
	}
	/** Models to fall back to when the upstream fetch fails; ignores visibility. */
	fallback() {
		return this.models;
	}
};
//#endregion
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback
* shim and the same-origin web-status route. Both are only ever meant to be
* addressed through the machine's loopback interface.
*
* @module dsh-workbuddy-oauth/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the WorkBuddy wire quirks (forced streaming, string
* `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
* It binds 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-workbuddy-oauth/shim
*/
/**
* How long an upstream failure parks an account out of selection.
*
* The two durations differ by an order of magnitude because the *cause* differs:
*
* - `hard_credit` means the account is out of credit. That does not clear in a
*   minute — measured, the upstream answers `额度已用尽` and offers a top-up
*   purchase link — so a short cooldown would put the account back in rotation
*   and burn a failing request every interval. One hour is a compromise between
*   "do not retry a dead account" and "notice automatically if credit returns";
*   the user can also re-enable or sign in again explicitly.
* - `soft_rate` means "too fast": the upstream's own limit resets on its own, so
*   a short park is enough to stop the next request from hitting the same wall.
*
* `server` (5xx) is transient by nature, hence the shortest.
*/
const FAILURE_COOLDOWN_MS = {
	hard_credit: 36e5,
	soft_rate: 6e4,
	server: 1e4
};
/**
* The cooldown a failure class warrants, or `undefined` for classes that must
* not park an account (`session_dead` is "sign in again", `not_found`/`client`
* are request-shape problems that would fail identically on any account).
*/
function cooldownForKind(kind, now = Date.now()) {
	const ms = kind === "hard_credit" || kind === "soft_rate" || kind === "server" ? FAILURE_COOLDOWN_MS[kind] : void 0;
	return ms === void 0 ? void 0 : now + ms;
}
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const affinityHeader = req.headers["x-session-id"];
		const sessionKey = typeof affinityHeader === "string" && affinityHeader !== "" ? affinityHeader : void 0;
		let credential;
		try {
			credential = await store.resolve(sessionKey);
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const prepared = prepareChatBody((await readBody$1(req)).toString("utf8"));
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		logger?.info(`dsh-workbuddy-oauth: chat ${result.ok ? "ok" : result.kind} via uid=${credential.uid.slice(0, 8)}${sessionKey === void 0 ? " (no session)" : ""}`);
		if (!result.ok) {
			const until = cooldownForKind(result.kind);
			if (until !== void 0) store.noteFailure(credential.uid, until);
			const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400);
			const statusNote = (result.status === 401 || result.status === 403) && result.kind !== "session_dead" ? "" : ` (http ${result.status})`;
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `workbuddy upstream ${result.kind}${statusNote}: ${detail}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddy-oauth: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/credentials.ts
/**
* Plugin-owned credential store.
*
* Replaces `dsh-workbuddy-connect`'s desktop-credential reader. Credentials
* come from this plugin's own OAuth flow ({@link ./oauth.ts}) and live in one
* file per account under `$DSH_HOME/workbuddy-oauth/`, so:
*
* - no desktop app is required, and none is read;
* - several accounts can coexist (the file name carries the uid);
* - token refresh writes only our own file.
*
* `expiresAtMs` is epoch **milliseconds** here. The upstream OAuth call returns
* `expiresIn` in seconds, so conversion happens once, at this boundary.
*
* @module dsh-workbuddy-oauth/credentials
*/
/** Directory under the Harness home that holds this plugin's state. */
const STATE_DIR_NAME = "workbuddy-oauth";
/** Prefix of each credential file; the remainder is the account uid. */
const CREDENTIAL_FILE_PREFIX = "workbuddy-";
/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION$4 = 1;
/** Root directory for this plugin's state. */
function stateDir() {
	return join(resolveDshHome(), STATE_DIR_NAME);
}
/** Directory holding one file per account. */
function credentialsDir() {
	return join(stateDir(), "accounts");
}
/**
* Absolute path of one plugin-owned state file.
*
* Everything this plugin writes lives under {@link stateDir()}, so a single
* directory can be deleted to reset it and nothing is scattered across the
* Harness home.
*
* @param name - file name inside the state directory.
*/
function stateFilePath(name) {
	return join(stateDir(), name);
}
/**
* Path of one region's probe-record file.
*
* **Deliberately not the ported default.** `probe-store.ts`'s
* `workbuddyProbePath()` resolves to `$DSH_HOME/.workbuddy-probe.json`, which is
* exactly where `dsh-workbuddy-connect` keeps its own CN records. Sharing that
* file would make two plugins write one document, and while the records are
* account-keyed the *fingerprint basis* is each plugin's own — so a record
* written by one could be judged stale by the other and silently re-probed.
* Per region, because the two upstreams disagree about rates and effort sets
* for the same model ids, so a CN observation must never answer for a global
* row.
*/
function probePathFor(region) {
	return stateFilePath(`probe-${region}.json`);
}
/** Absolute path of one account's credential file. */
function credentialPath(uid) {
	return join(credentialsDir(), `${CREDENTIAL_FILE_PREFIX}${uid}.json`);
}
/** Whether a parsed value looks like a credential document we can trust. */
function isCredentialDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== FORMAT_VERSION$4) return false;
	const credential = document.credential;
	if (typeof credential !== "object" || credential === null) return false;
	const candidate = credential;
	return typeof candidate.accessToken === "string" && candidate.accessToken !== "" && typeof candidate.uid === "string" && candidate.uid !== "" && typeof candidate.domain === "string" && typeof candidate.expiresAtMs === "number" && Number.isFinite(candidate.expiresAtMs);
}
/**
* Parse one credential file.
*
* @returns The credential, or `undefined` when the file is absent, malformed
*   or written by an incompatible version. A damaged file is reported as
*   "not signed in" rather than thrown, so one bad account cannot take down
*   the whole pool.
*/
async function readCredential(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(text);
		if (!isCredentialDocument(parsed)) return void 0;
		return normalizeCredential(parsed.credential);
	} catch {
		return;
	}
}
/**
* Fill in derived fields a stored document may predate.
*
* `region` is recomputed from `domain` rather than trusted from disk: it is a
* pure function of the domain, and a stale stored value would silently route
* requests at the wrong region.
*/
function normalizeCredential(stored) {
	return {
		...stored,
		region: regionOfDomain(stored.domain)
	};
}
/**
* Write one account's credential without taking the file lock.
*
* Only for callers that already hold it. `withFileLock` is not reentrant, so a
* caller holding the lock and then calling the locked {@link writeCredential}
* would deadlock against itself until the timeout.
*/
async function writeCredentialUnlocked(credential) {
	const path = credentialPath(credential.uid);
	const document = {
		version: FORMAT_VERSION$4,
		credential
	};
	await mkdir(credentialsDir(), { recursive: true });
	await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	});
	return path;
}
/** Write one account's credential atomically, under the file lock. */
async function writeCredential(credential) {
	const path = credentialPath(credential.uid);
	await mkdir(credentialsDir(), { recursive: true });
	return withFileLock(path, () => writeCredentialUnlocked(credential));
}
/** Remove one account's credential file. Returns whether a file was removed. */
async function deleteCredential(uid) {
	const path = credentialPath(uid);
	try {
		await rm(path, { force: false });
		return true;
	} catch {
		return false;
	}
}
/**
* List every stored credential.
*
* Unreadable or unparsable files are skipped rather than failing the listing:
* a single damaged account must not hide the healthy ones.
*/
async function listCredentials() {
	let names;
	try {
		names = await readdir(credentialsDir());
	} catch {
		return [];
	}
	const found = [];
	for (const name of names) {
		if (!name.startsWith("workbuddy-") || !name.endsWith(".json")) continue;
		const credential = await readCredential(join(credentialsDir(), name));
		if (credential !== void 0) found.push(credential);
	}
	return found.sort((a, b) => a.uid.localeCompare(b.uid));
}
/**
* Convert a completed login into a storable credential.
*
* `expiresIn` arrives in seconds and `now` in milliseconds, so the conversion
* happens exactly here.
*
* @param result - Output of {@link LoginClient.complete}.
* @param now - Current time in epoch milliseconds; injectable for tests.
*/
function credentialFromLogin(result, now = Date.now()) {
	return withAccountFields({
		accessToken: result.token.accessToken,
		refreshToken: result.token.refreshToken,
		expiresAtMs: now + result.token.expiresIn * 1e3,
		domain: result.token.domain,
		uid: result.account.uid,
		region: result.region
	}, result.account);
}
/** Attach the optional account fields only when they carry a value. */
function withAccountFields(credential, account) {
	return {
		...credential,
		...account.enterpriseId !== "" ? { enterpriseId: account.enterpriseId } : {},
		...account.nickname !== "" ? { nickname: account.nickname } : {}
	};
}
/** Whether a credential's access token is expired or about to expire. */
function isExpired(credential, marginMs = 6e4, now = Date.now()) {
	return credential.expiresAtMs - marginMs <= now;
}
/**
* A mainland-China mobile number, optionally carrying an `86` country code.
*
* The surrounding `(?<!\d)` / `(?!\d)` guards keep a longer digit run from being
* partially masked: in `113800138000` the inner digits are not a phone number,
* and masking them would mangle an id that merely contains those digits.
*/
const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/gu;
/**
* How many leading and trailing digits stay readable; the rest become `*`.
*
* Two, not three. The first three digits of a mainland mobile number are the
* carrier prefix, not personal data — but the fourth is the first digit of the
* subscriber's own segment, and with three visible on each side only five
* digits are hidden out of eleven. Two leaves seven hidden and still tells two
* accounts apart at a glance.
*/
const PHONE_VISIBLE_DIGITS = 2;
/**
* Mask any mobile number inside a display name.
*
* Applied at the *display* boundary only: the credential file keeps the real
* nickname, so nothing is lost and a later feature can still use it. A name that
* merely contains a number — `张三 13800138000` — is masked in place, because
* redacting only exact matches would leak the common case.
*
* A country-code prefix the user typed is kept (`+86` is not personal data); only
* the number itself is redacted.
*
* @param text - the raw display name.
* @returns the name with every mobile number reduced to `2 digits + stars + 2`.
*/
function maskPhoneNumbers(text) {
	return text.replace(PHONE_PATTERN, (whole, digits) => {
		const stars = "*".repeat(Math.max(0, digits.length - 4));
		const masked = `${digits.slice(0, PHONE_VISIBLE_DIGITS)}${stars}${digits.slice(-2)}`;
		return whole.replace(digits, masked);
	});
}
/**
* An email address, as it commonly appears in a nickname.
*
* The local part is required to be non-empty and the domain to carry at least
* one dot, so a bare `user@host` (an internal id, not an address) is left alone.
* The leading guard keeps a match from starting mid-token.
*/
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;
/** Leading/trailing characters of the local part kept when there is room. */
const EMAIL_VISIBLE_CHARS = 2;
/**
* Reduce a local part to a fixed, short form with the middle hidden.
*
* **Short by design.** The masked name is the account label in every list, so a
* faithful-looking mask is also a wide one: `2*********@gmail.com` is twenty
* characters and stretches the whole table it appears in. The middle collapses
* to a *single* star regardless of how much it hides, which is what keeps the
* label's width bounded rather than proportional to the address.
*
* At least one character is always hidden, including for short local parts —
* `ab` masks to `a*`, not to a form that reveals both characters.
*/
function maskLocalPart(local) {
	if (local.length <= 1) return "*";
	if (local.length >= 5) return `${local.slice(0, EMAIL_VISIBLE_CHARS)}*${local.slice(-2)}`;
	return local.length >= 3 ? `${local.slice(0, 1)}*${local.slice(-1)}` : `${local.slice(0, 1)}*`;
}
/**
* Drop the domain's last label (its TLD).
*
* `gmail.com` names a provider, but `.com` names nothing; keeping only the
* registrable part shortens every address by a constant amount. A multi-label
* domain keeps all but its final label, so `example.com.cn` becomes
* `example.com`.
*/
function shortenDomain(domain) {
	return domain.replace(/\.[A-Za-z0-9-]+$/, "");
}
/**
* Mask the local part of any email address inside a display name.
*
* Accounts are frequently named after the address they signed up with, and the
* local part is the identifying half — `alice1990` names a person, while
* `example` names only a provider. So the local part keeps its first and last
* {@link EMAIL_VISIBLE_CHARS} characters with one star between them, and the TLD
* is dropped: `alice1990@example.com` renders as `al*90@example`.
*
* Like {@link maskPhoneNumbers}, this is a *display* transform only: the stored
* nickname keeps the real value.
*
* @param text - the raw display name.
* @returns the name with every address shortened to `ab*cd@provider`.
*/
function maskEmailAddresses(text) {
	return text.replace(EMAIL_PATTERN, (whole, local, domain) => `${maskLocalPart(local)}@${shortenDomain(domain)}`);
}
/**
* Redact every personal identifier this plugin knows how to recognize.
*
* One entry point so a new identifier type cannot be added to one surface and
* forgotten on another: every caller that renders a name goes through here.
*/
function maskPersonalData(text) {
	return maskEmailAddresses(maskPhoneNumbers(text));
}
/**
* Human-readable account label for status output.
*
* The nickname is masked rather than returned raw: an account nicknamed with its
* own phone number or email address would otherwise be printed verbatim by every
* command, the settings card, and the status document.
*/
function displayNameOf(credential) {
	if (credential.nickname !== void 0 && credential.nickname !== "") return maskPersonalData(credential.nickname);
	return credential.uid.slice(0, 8);
}
//#endregion
//#region src/account-state.ts
/**
* Per-account enable/disable state.
*
* A disabled account is still *stored* (its credential file stays on disk) but
* is excluded from credential selection, so its token is never spent until the
* user re-enables it. The state lives in its own file rather than inside the
* credential document: the credential format is written by the OAuth flow and
* read by the ported code, and widening it for an enable flag would force a
* format-version migration for a fact that is only about *selection*.
*
* @module dsh-workbuddy-oauth/account-state
*/
/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION$3 = 1;
/** Name of the state file inside {@link stateDir}. */
const DISABLED_ACCOUNTS_FILENAME = "disabled-accounts.json";
/** Path of the disabled-accounts state file. */
function disabledPath() {
	return stateFilePath(DISABLED_ACCOUNTS_FILENAME);
}
/** Whether a parsed value is a disabled-accounts document we can trust. */
function isDisabledDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== FORMAT_VERSION$3) return false;
	return Array.isArray(document.disabled) && document.disabled.every((uid) => typeof uid === "string");
}
/** Read the current disabled set; an absent or damaged file reads as empty. */
async function readDisabled() {
	let text;
	try {
		text = await readFile(disabledPath(), "utf8");
	} catch {
		return /* @__PURE__ */ new Set();
	}
	try {
		const parsed = JSON.parse(text);
		return isDisabledDocument(parsed) ? new Set(parsed.disabled) : /* @__PURE__ */ new Set();
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
/** Write the disabled set atomically; a failed write is reported, never thrown. */
async function writeDisabled(disabled) {
	const document = {
		version: FORMAT_VERSION$3,
		disabled: [...disabled].sort()
	};
	await mkdir(stateFilePath("."), { recursive: true });
	await withFileLock(disabledPath(), () => writeFileAtomic(disabledPath(), `${JSON.stringify(document, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	}));
}
/**
* The set of disabled account uids.
*
* Read on demand so a `/wb-account` toggle in another DSH window is honoured on
* the next selection without a restart.
*/
async function disabledUids() {
	return readDisabled();
}
/**
* Forget one account's enable/disable state.
*
* Called when an account is removed. A disabled uid that outlives its
* credential is a stale identifier left on disk for no purpose, and if the same
* uid is ever re-added it would silently come back disabled.
*
* @returns whether the uid was present and therefore removed.
*/
async function forgetAccount(uid) {
	const current = await readDisabled();
	if (!current.delete(uid)) return false;
	await writeDisabled(current);
	return true;
}
/**
* Enable or disable one account.
*
* Idempotent: disabling an already-disabled account and enabling an already-
* enabled one both settle to the requested state.
*
* @returns the new disabled set, for callers that want to re-read selection.
*/
async function setAccountDisabled(uid, disabled) {
	const current = await readDisabled();
	if (disabled) current.add(uid);
	else current.delete(uid);
	await writeDisabled(current);
	return current;
}
//#endregion
//#region src/cooldown-state.ts
/**
* Persisted failure cooldowns.
*
* The cooldown map (`uid → cool-until epoch ms`) lives in memory while the
* process runs. This module adds a write-through disk copy so a DSH restart does
* not resurrect a cooled account: an account that exhausted its credit an hour
* ago must not be retried on the next start, because the failure it would hit is
* exactly the one the cooldown exists to avoid.
*
* Deliberately **not** persisted: the rotation cursor (restarting from account
* one is harmless) and session affinity (a 30-minute TTL that a restart exceeds
* anyway — conversations do not survive a host restart).
*
* The file is read when the store is built and on every write, so two DSH
* windows stay consistent the same way the disabled set is.
*
* @module dsh-workbuddy-oauth/cooldown-state
*/
/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION$2 = 1;
/** Name of the state file inside the plugin state directory. */
const COOLDOWN_STATE_FILENAME = "cooldowns.json";
/** Path of the cooldown state file. */
function cooldownPath() {
	return stateFilePath(COOLDOWN_STATE_FILENAME);
}
/**
* Whether a parsed value is a cooldown document we can trust.
*
* Rejecting malformed entries outright (rather than skipping them) is what makes
* a damaged file read as empty: a single bad value would otherwise poison a map
* the selection loop trusts with account routing.
*/
function isCooldownDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== FORMAT_VERSION$2) return false;
	const map = document.cooldowns;
	if (typeof map !== "object" || map === null || Array.isArray(map)) return false;
	return Object.entries(map).every(([uid, until]) => typeof uid === "string" && uid !== "" && typeof until === "number" && Number.isFinite(until));
}
/** Read the persisted map, dropping entries that have already expired. */
async function readCooldowns(now = Date.now()) {
	const path = cooldownPath();
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return /* @__PURE__ */ new Map();
	}
	try {
		const parsed = JSON.parse(text);
		if (!isCooldownDocument(parsed)) return /* @__PURE__ */ new Map();
		return new Map(Object.entries(parsed.cooldowns).filter(([, until]) => until > now));
	} catch {
		return /* @__PURE__ */ new Map();
	}
}
/**
* Writes still in flight, so tests can wait for persistence deterministically.
*
* `noteFailure` is fire-and-forget — a request must never wait on a state-file
* write — but a test that ends while its write is suspended would race the
* environment restore in the test harness and land the entry in the real home
* directory (observed: an entry written to `~/.dsh` by a temp-dir test).
*/
const pendingWrites$2 = /* @__PURE__ */ new Set();
/**
* Merge one entry into the persisted map atomically.
*
* Read-modify-write under a file lock so a toggle made in another DSH window is
* not lost, mirroring {@link ../account-state.ts!setAccountDisabled}. A failed
* write is reported to the caller's catch and never thrown: losing a
* persistence update must not break the request that produced it.
*
* All three paths are computed **before the first await**, for the same reason
* {@link readCooldowns} captures its path up front: this function is usually
* called fire-and-forget, so its later awaits routinely outlive the environment
* (and `DSH_HOME`) it was called under.
*/
async function writeCooldown(uid, untilMs, now = Date.now()) {
	const path = cooldownPath();
	const dir = stateFilePath(".");
	const task = (async () => {
		const current = await readCooldowns(now);
		if (current.get(uid) === untilMs) return;
		current.set(uid, untilMs);
		const document = {
			version: FORMAT_VERSION$2,
			cooldowns: Object.fromEntries([...current].sort(([a], [b]) => a.localeCompare(b)))
		};
		await mkdir(dir, { recursive: true });
		await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		}));
	})();
	pendingWrites$2.add(task);
	task.catch(() => {}).finally(() => {
		pendingWrites$2.delete(task);
	});
	return task;
}
/**
* Drop one account's persisted cooldown entry.
*
* Called when an account is removed. Without this the uid outlives the
* credential it described: the file keeps naming an account that no longer
* exists, which is both a privacy leak (the uid is an account identifier) and a
* slow accumulation of dead entries.
*
* @returns whether an entry was actually removed.
*/
async function clearCooldown(uid, now = Date.now()) {
	const path = cooldownPath();
	const dir = stateFilePath(".");
	const current = await readCooldowns(now);
	if (!current.delete(uid)) return false;
	const document = {
		version: FORMAT_VERSION$2,
		cooldowns: Object.fromEntries([...current].sort(([a], [b]) => a.localeCompare(b)))
	};
	await mkdir(dir, { recursive: true });
	await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	}));
	return true;
}
//#endregion
//#region src/refresh.ts
/**
* Token refresh.
*
* Two properties here are account-safety properties, not conveniences.
*
* ## 1. One refresh at a time per account (single flight)
*
* The upstream **rotates** the refresh token: the response carries a new one
* and the old one is spent. Two concurrent refreshes for the same account
* therefore race — the second sends a token the first already consumed, which
* the upstream reads as replay of a used credential. That is the shape of a
* stolen-token attack, and it is exactly what risk control is looking for.
*
* In-process callers are de-duplicated through a shared promise, so N callers
* cause one request. The cross-process case is handled by serializing the
* whole read-refresh-write cycle under the credential file lock, so a second
* process re-reads the freshly committed token and skips its refresh.
*
* ## 2. Do not refresh on a timer
*
* Refreshing in the background "just in case" multiplies credential traffic
* for no benefit. Refresh lazily, only when a request actually needs a token
* that is at or near expiry, with a margin so a token cannot expire mid-flight.
*
* The shape of the request (POST, `X-Refresh-Token`, the `X-Auth-Refresh-Source`
* discriminator) follows the reference implementations, which are the ones
* observed working against the live upstream.
*
* @module dsh-workbuddy-oauth/refresh
*/
/** Endpoint that exchanges a refresh token for a new access token. */
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/**
* Refresh this long before expiry.
*
* Five minutes matches the reference implementations and is comfortably longer
* than one chat turn, so a token cannot expire between being checked and being
* used.
*/
const REFRESH_MARGIN_MS = 3e5;
/** User agent for refresh calls. */
const REFRESH_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
/** Headers the refresh endpoint expects. */
function refreshHeaders(credential) {
	const { origin } = regionEndpoints(credential.region);
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"User-Agent": REFRESH_USER_AGENT,
		Origin: origin,
		Referer: `${origin}/`,
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": credential.region === "cn" ? "workbuddy" : "plugin",
		"X-User-Id": credential.uid,
		"X-CodeBuddy-Request": "1",
		"Accept-Language": credential.region === "global" ? "en-US" : "zh-CN"
	};
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/**
* Whether a credential needs refreshing.
*
* @param credential - The stored credential.
* @param now - Current epoch milliseconds.
* @param marginMs - Refresh when expiry is nearer than this.
*/
function needsRefresh(credential, now = Date.now(), marginMs = REFRESH_MARGIN_MS) {
	if (credential.refreshToken === "") return false;
	return credential.expiresAtMs - marginMs <= now;
}
/** Pull the new tokens out of the upstream envelope, tolerating its nesting. */
function extractTokens(payload) {
	if (typeof payload !== "object" || payload === null) return {};
	const first = payload["data"];
	const inner = typeof first === "object" && first !== null && "data" in first ? first["data"] : first;
	if (typeof inner !== "object" || inner === null) return {};
	const body = inner;
	const result = {};
	if (typeof body["accessToken"] === "string") result.accessToken = body["accessToken"];
	if (typeof body["refreshToken"] === "string") result.refreshToken = body["refreshToken"];
	if (typeof body["expiresIn"] === "number" && Number.isFinite(body["expiresIn"])) result.expiresIn = body["expiresIn"];
	return result;
}
/** In-process single-flight table, keyed by uid. */
const inFlight = /* @__PURE__ */ new Map();
/**
* Refresh one account's token if needed.
*
* Concurrent calls for the same uid share one request, and the cycle is
* serialized under the credential file lock so a second process re-reads the
* committed token instead of replaying a spent refresh token.
*
* @param uid - Account to refresh; its stored credential is the input.
* @param deps - Optional fetch/clock overrides.
*/
async function refreshCredential(uid, deps = {}) {
	const existing = inFlight.get(uid);
	if (existing !== void 0) return existing;
	const run = (async () => {
		const path = credentialPath(uid);
		if (await readCredential(path) === void 0) return {
			status: "failed",
			reason: "账号凭据不存在或已损坏，请重新登录。"
		};
		return withFileLock(path, async () => {
			const stored = await readCredential(path);
			if (stored === void 0) return {
				status: "failed",
				reason: "账号凭据不存在或已损坏，请重新登录。"
			};
			const now = (deps.now ?? Date.now)();
			if (!needsRefresh(stored, now)) return {
				status: "not-needed",
				credential: stored
			};
			if (stored.refreshToken === "") return {
				status: "failed",
				reason: "没有 refresh token，需要重新登录。"
			};
			const fetchImpl = deps.fetchImpl ?? fetch;
			const { base } = regionEndpoints(stored.region);
			let response;
			try {
				response = await fetchImpl(`${base}${REFRESH_PATH}`, {
					method: "POST",
					headers: refreshHeaders(stored),
					body: "{}",
					signal: AbortSignal.timeout(deps.timeoutMs ?? 3e4)
				});
			} catch (error) {
				return {
					status: "failed",
					reason: `刷新请求失败：${error instanceof Error ? error.message : String(error)}`
				};
			}
			const text = await response.text().catch(() => "");
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				return {
					status: "failed",
					reason: `刷新响应不是 JSON（HTTP ${response.status}）`
				};
			}
			const tokens = extractTokens(payload);
			if (tokens.accessToken === void 0 || tokens.accessToken === "") return {
				status: "failed",
				reason: `刷新未返回新 token：${typeof payload === "object" && payload !== null && "msg" in payload ? String(payload["msg"]) : `HTTP ${response.status}`}`
			};
			const refreshed = {
				...stored,
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken ?? stored.refreshToken,
				expiresAtMs: tokens.expiresIn !== void 0 ? now + tokens.expiresIn * 1e3 : stored.expiresAtMs
			};
			await writeCredentialUnlocked(refreshed);
			return {
				status: "refreshed",
				credential: refreshed
			};
		}, { waitMs: 6e4 });
	})();
	inFlight.set(uid, run);
	try {
		return await run;
	} finally {
		inFlight.delete(uid);
	}
}
//#endregion
//#region src/store.ts
/**
* Credential resolution for the provider and shim.
*
* The ported shim and adapter were written against connect's
* `WorkBuddyCredentialStore`, which resolves a desktop-app credential and
* refreshes it. This module presents the same narrow surface — `resolve()` —
* on top of this plugin's own OAuth credentials ({@link ./credentials.ts}),
* so the ported code needed no changes to its credential handling.
*
* ## Why a thin adapter instead of changing the ported code
*
* Keeping the seam identical means the parts that were verified against the
* live upstream (header construction, chat body preparation, error
* classification) stay untouched, and only the *source of the credential*
* differs. That is the whole point of this plugin.
*
* ## Single account in Phase 1
*
* `resolve()` returns the account that should serve the next request. Phase 1
* has exactly one decision — when several credentials exist, prefer one whose
* token is still valid, and fall back to the lexicographically first so the
* choice is stable rather than arbitrary. Token selection *per conversation*
* (affinity) and health-based rotation are Phase 2 concerns; leaving them out
* here keeps this module honest about what it does.
*
* @module dsh-workbuddy-oauth/store
*/
/** Thrown when no usable credential exists; the shim maps this to HTTP 401. */
var NotSignedInError = class extends Error {
	constructor(message = "尚未登录 WorkBuddy。请先执行 /wb-login 完成登录。") {
		super(message);
		this.name = "NotSignedInError";
	}
};
/** How long a conversation keeps its pinned account without a request. */
const SESSION_AFFINITY_TTL_MS = 18e5;
/**
* Rotating selection: pick the next ready account in ring order.
*
* The single-account rule is stable here because a one-account pool always
* answers that account; rotation only becomes visible with two or more. Order
* of preference within one call:
*
* 1. unexpired token: choosing an expired one would spend a refresh cycle (and
*    a rotation) on a request that another account could serve as-is;
* 2. not currently cooled out (a recently failed account stays parked);
* 3. ring order from `cursor`, so load spreads instead of always hitting the
*    lexicographically-first account.
*
* When *every* account is cooled out, the soonest-to-recover account is served
* anyway — refusing would leave the whole pool unusable until a timer fires,
* and for a personal install a short wait on the least-bad account is better
* than a hard failure.
*
* Pure, and exported so the rule is testable without touching the filesystem.
* `credentials` are already filtered to one region by the caller: a credential
* is only ever valid for its own upstream host, so presenting a domestic token
* to the international service (or vice versa) is an authentication failure,
* and the caller knows which endpoint it is about to call.
*
* @returns the chosen credential and the next cursor, or `undefined` when none.
*/
function chooseRotating(credentials, cursor, cooldownUntilMs, now = Date.now()) {
	if (credentials.length === 0) return void 0;
	const live = credentials.filter((credential) => !isExpired(credential, 0, now));
	const base = live.length > 0 ? live : credentials;
	const ready = base.filter((credential) => (cooldownUntilMs.get(credential.uid) ?? 0) <= now);
	if (ready.length > 0) {
		const index = (cursor % ready.length + ready.length) % ready.length;
		return {
			credential: ready[index],
			nextCursor: (index + 1) % ready.length
		};
	}
	const soonest = [...base].sort((a, b) => (cooldownUntilMs.get(a.uid) ?? 0) - (cooldownUntilMs.get(b.uid) ?? 0))[0];
	return soonest === void 0 ? void 0 : {
		credential: soonest,
		nextCursor: 0
	};
}
/**
* Build the credential store the ported shim and adapter consume.
*
* `resolve()` refreshes when the chosen token is at or near expiry, and
* reports {@link NotSignedInError} when nothing is stored — the shim turns that
* into a 401 carrying the message, so an unconfigured install reports "sign in"
* rather than an opaque failure.
*/
function createCredentialStore(options = {}) {
	const now = options.now ?? Date.now;
	const refresh = options.refresh ?? refreshCredential;
	const region = options.region;
	let cursor = 0;
	const cooldownUntilMs = /* @__PURE__ */ new Map();
	const cooldownLoaded = readCooldowns(now()).then((loaded) => {
		for (const [uid, until] of loaded) cooldownUntilMs.set(uid, until);
	}).catch(() => {});
	const affinity = /* @__PURE__ */ new Map();
	/** Credentials this store may serve: its own region's, when one is set. */
	const candidates = async () => {
		const all = await listCredentials();
		const byRegion = region === void 0 ? all : all.filter((credential) => credential.region === region);
		const disabled = await disabledUids();
		return byRegion.filter((credential) => !disabled.has(credential.uid));
	};
	/** Whether an account may serve a request right now (enabled, not cooled). */
	const selectable = (credential) => (cooldownUntilMs.get(credential.uid) ?? 0) <= now();
	/** The account pinned to a conversation, when the pin is still alive. */
	const pinnedUid = (sessionKey) => {
		if (sessionKey === void 0) return void 0;
		const entry = affinity.get(sessionKey);
		if (entry === void 0) return void 0;
		if (entry.expiresAt <= now()) {
			affinity.delete(sessionKey);
			return;
		}
		return entry.uid;
	};
	const pin = (sessionKey, uid) => {
		if (sessionKey === void 0) return;
		affinity.set(sessionKey, {
			uid,
			expiresAt: now() + SESSION_AFFINITY_TTL_MS
		});
	};
	return {
		async current() {
			await cooldownLoaded;
			const chosen = chooseRotating(await candidates(), cursor, cooldownUntilMs, now());
			if (chosen === void 0) return void 0;
			cursor = chosen.nextCursor;
			return chosen.credential;
		},
		async resolve(sessionKey) {
			await cooldownLoaded;
			const creds = await candidates();
			let chosen;
			const pinned = pinnedUid(sessionKey);
			if (pinned !== void 0) {
				chosen = creds.find((credential) => credential.uid === pinned && selectable(credential));
				if (chosen !== void 0) pin(sessionKey, chosen.uid);
			}
			if (chosen === void 0) {
				const rotating = chooseRotating(creds, cursor, cooldownUntilMs, now());
				if (rotating === void 0) throw new NotSignedInError();
				cursor = rotating.nextCursor;
				chosen = rotating.credential;
				pin(sessionKey, chosen.uid);
			}
			if (!needsRefresh(chosen, now())) return chosen;
			const outcome = await refresh(chosen.uid);
			if (outcome.status === "failed") throw new NotSignedInError(`账号 ${displayNameOf(chosen)} 的登录已失效，请重新执行 /wb-login。原因：${outcome.reason}`);
			return await readCredential(credentialPath(chosen.uid)) ?? outcome.credential;
		},
		noteFailure(uid, untilMs) {
			cooldownUntilMs.set(uid, untilMs);
			writeCooldown(uid, untilMs, now()).catch(() => {});
		}
	};
}
/** Persist a freshly signed-in account. */
async function saveAccount(credential) {
	return writeCredential(credential);
}
//#endregion
//#region src/legacy-task-state.ts
/**
* Cleanup for `task-state.json`, a file this plugin no longer writes.
*
* The P4 task-automation feature was removed (`src/task-state.ts` is gone), but
* the file it left behind is keyed by account uid and nothing deletes it. On an
* install that predates the removal it survives every sign-out, so a uid stays
* on disk after the account it names is gone — the same leak `account-purge.ts`
* exists to prevent, on a file that module cannot know about because no source
* file names it any more.
*
* ## Why this deletes the whole file rather than one entry
*
* The writer is gone, so nothing can add an entry: any file still present is
* entirely stale. Removing one uid at a time would leave the rest of the
* document behind for no purpose, and there is no reader to be consistent with.
* A whole-file delete is therefore both simpler and more complete.
*
* ## Why it is a separate module
*
* `credentials.ts` owns `stateFilePath` and is imported by everything; the purge
* orchestrator imports the uid-keyed stores. Neither should grow knowledge of a
* removed feature. Keeping the legacy filename and its reasoning here means the
* day this module is deleted, nothing else has to change.
*
* @module dsh-workbuddy-oauth/legacy-task-state
*/
/**
* Name of the removed feature's state file.
*
* Exported so a test can create one without restating the literal.
*/
const LEGACY_TASK_STATE_FILENAME = "task-state.json";
/**
* Delete the removed feature's state file, if an older install left one.
*
* @returns whether a file was actually removed.
*/
async function removeLegacyTaskState() {
	try {
		await rm(stateFilePath(LEGACY_TASK_STATE_FILENAME), { force: false });
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/account-purge.ts
/**
* Complete removal of one account.
*
* Deleting the credential file alone is not enough: several other stores are
* keyed by the account's uid, and each of them would keep naming an account that
* no longer exists. That is both a privacy problem (a uid identifies an account)
* and a correctness one — if the same uid signs in again, a leftover disabled
* flag or a stale probe observation would silently apply to it.
*
* This module exists so every removal path (the `/wb-logout` command, the
* settings card's sign-out, and the store's own `removeAccount`) erases the same
* set. A new uid-keyed store must be added here, which is the point: the list is
* in one place rather than repeated at each call site.
*
* It also removes `task-state.json`, left by a feature this plugin no longer
* ships. That file is uid-keyed and has no writer, so it would otherwise
* outlive every account it names; see ./legacy-task-state.ts.
*
* @module dsh-workbuddy-oauth/account-purge
*/
/**
* Remove one account and every trace of it this plugin keeps.
*
* Deliberately **not** transactional: each store is independent, and a failure
* in one must not leave the credential file in place, because the credential is
* the secret. The credential is therefore deleted first, and a later failure is
* reported to the caller rather than rolled back — a leftover cooldown entry is
* harmless compared with a token that should have been erased.
*
* @param uid - the account uid to remove.
* @param options - probe-store hooks; omitted when the caller has none.
* @returns what was erased.
*/
async function purgeAccount(uid, options = {}) {
	const credentialRemoved = await deleteCredential(uid);
	const cooldownCleared = await clearCooldown(uid);
	const enableStateForgotten = await forgetAccount(uid);
	const legacyTaskStateRemoved = await removeLegacyTaskState();
	let probeStoresPurged = 0;
	const { forgetProbeRecords, accountKey } = options;
	if (forgetProbeRecords !== void 0 && accountKey !== void 0 && accountKey !== "") probeStoresPurged = forgetProbeRecords(accountKey);
	return {
		credentialRemoved,
		cooldownCleared,
		enableStateForgotten,
		probeStoresPurged,
		legacyTaskStateRemoved
	};
}
//#endregion
//#region src/hidden-models.ts
/**
* Per-region hidden-model set.
*
* The user can hide a model from the DSH picker; the rule is about **model ids
* per region**, not about accounts — the CN and international rosters are
* different lists, and a hidden id survives a later catalog refresh because the
* set is keyed by id rather than by the row that was present when it was set.
* (Chats already using a hidden model keep working: the shim routes on the id,
* and only the picker's roster is filtered.)
*
* Persisted so a restart does not resurrect a model the user deliberately hid.
*
* @module dsh-workbuddy-oauth/hidden-models
*/
/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION$1 = 1;
/** Name of the state file inside the plugin state directory. */
const HIDDEN_MODELS_FILENAME = "hidden-models.json";
/** Path of the hidden-models state file. */
function hiddenModelsPath() {
	return stateFilePath(HIDDEN_MODELS_FILENAME);
}
/** Whether a parsed value is a hidden-models document we can trust. */
function isHiddenModelsDocument(value) {
	if (typeof value !== "object" || value === null) return false;
	const document = value;
	if (document.version !== FORMAT_VERSION$1) return false;
	const hidden = document.hidden;
	if (typeof hidden !== "object" || hidden === null || Array.isArray(hidden)) return false;
	return ["cn", "global"].every((region) => Array.isArray(hidden[region]) && hidden[region].every((id) => typeof id === "string" && id !== ""));
}
/** Reads still in flight, so tests can wait deterministically (see cooldown-state). */
const pendingWrites$1 = /* @__PURE__ */ new Set();
/** Read the whole document; absent or damaged reads as both regions empty. */
async function readHiddenModels() {
	const path = hiddenModelsPath();
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {
			cn: [],
			global: []
		};
	}
	try {
		const parsed = JSON.parse(text);
		return isHiddenModelsDocument(parsed) ? parsed.hidden : {
			cn: [],
			global: []
		};
	} catch {
		return {
			cn: [],
			global: []
		};
	}
}
/**
* Replace one region's hidden set atomically, preserving the other region's.
*
* Read-modify-write under a file lock (same discipline as `account-state.ts`),
* so two DSH windows toggling different regions do not erase each other.
*/
async function setRegionHiddenModels(region, ids) {
	const path = hiddenModelsPath();
	const dir = stateFilePath(".");
	const task = (async () => {
		const current = await readHiddenModels();
		const next = {
			cn: [...current.cn],
			global: [...current.global],
			[region]: [...ids].sort()
		};
		const document = {
			version: FORMAT_VERSION$1,
			hidden: next
		};
		await mkdir(dir, { recursive: true });
		await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		}));
	})();
	pendingWrites$1.add(task);
	task.catch(() => {}).finally(() => {
		pendingWrites$1.delete(task);
	});
	return task;
}
//#endregion
//#region src/preferences.ts
/**
* A single persisted plugin preference: whether to use the upstream's largest
* declared context window.
*
* Only the international roster declares `supportedContextWindows`, so in
* practice this flag only changes international models; the CN catalog never
* carries a larger window and is unaffected. The flag is global rather than
* per-region because it is one user decision, not two.
*
* Persisted so a restart keeps the user's choice (same reason `hidden-models.ts`
* persists, and the same discipline: atomic write, file lock, versioned shape).
*
* @module dsh-workbuddy-oauth/preferences
*/
/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1;
/** Name of the state file inside the plugin state directory. */
const PREFERENCES_FILENAME = "preferences.json";
/** Path of the preferences state file. */
function preferencesPath() {
	return stateFilePath(PREFERENCES_FILENAME);
}
/** Reads still in flight, so tests can wait deterministically. */
const pendingWrites = /* @__PURE__ */ new Set();
/** Read the preference; absent or damaged reads as the default (`false`). */
async function readUseMaximumContextWindow() {
	let text;
	try {
		text = await readFile(preferencesPath(), "utf8");
	} catch {
		return false;
	}
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && parsed.version === FORMAT_VERSION && typeof parsed.useMaximumContextWindow === "boolean") return parsed.useMaximumContextWindow;
		return false;
	} catch {
		return false;
	}
}
/** Persist the preference atomically. */
async function writeUseMaximumContextWindow(useMaximum) {
	const path = preferencesPath();
	const dir = stateFilePath(".");
	const document = {
		version: FORMAT_VERSION,
		useMaximumContextWindow: useMaximum
	};
	const task = (async () => {
		await mkdir(dir, { recursive: true });
		await withFileLock(path, () => writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		}));
	})();
	pendingWrites.add(task);
	task.catch(() => {}).finally(() => {
		pendingWrites.delete(task);
	});
	return task;
}
//#endregion
//#region src/oauth.ts
/**
* OAuth device-code sign-in, owned by this plugin.
*
* This module is the structural difference from `dsh-workbuddy-connect`:
* connect reads (and decrypts) the WorkBuddy desktop app's credential file,
* which is why it ships ~50 KB of credential-protection code and breaks when
* the desktop app changes its at-rest format. Here the plugin obtains its own
* credential straight from the upstream OAuth endpoints, so no desktop app,
* no decryption and no file-format tracking is involved.
*
* The flow is deliberately non-interactive: `state` → hand the URL to the
* user → poll for the token. No TTY, no local callback port.
*
* Endpoints, headers and the `{code,msg,data}` envelope mirror the flow the
* official CLI performs. `expiresIn` is in **seconds**.
*
* @module dsh-workbuddy-oauth/oauth
*/
/** User agent the login endpoints expect. Do not substitute the plugin's own. */
const LOGIN_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
* The `platform` value the sign-in request asks for.
*
* **Not `CLI`.** The desktop app's own authorization URL reports
* `platform=workbuddy`, and phone-number sign-in on the resulting page fails with
* `无效的token` (`sl_…`, a OneID token) when the page is opened for a
* `CLI`-scoped state — measured by comparing the two URLs. `CLI` is what both
* reference implementations send, so this diverges from them deliberately: they
* expose an OpenAI-compatible gateway where the CLI flow is the whole product,
* while this plugin is signing in on behalf of a desktop-app user.
*/
const AUTH_PLATFORM = "workbuddy";
/**
* Add the one query parameter the desktop app's authorization URL needs.
*
* The state endpoint echoes back only `platform` and `state`; the desktop app
* appends `loginSessionId` client-side (the endpoint ignores it on the request).
* It is a fresh UUID per attempt, so it is a correlation id rather than server
* state, and it is what lets the phone-login (OneID) path tie the page to the
* client that opened it — without it the page's phone flow rejects the token.
*
* **`version` is deliberately not sent.** The app's URL carries one, but it is
* not required: the page returns byte-identical HTML with and without it
* (`0.0.1`, `5.5.6`, `99.0.0` and absent all measured the same). Sending our own
* would mean *claiming* a client version that nothing in the plugin can keep
* current — the upstream publishes no queryable desktop-app version (no field in
* `/v3/config`, no update feed, no npm package; the only published official
* package is the CLI, which is a different product and a different numbering) —
* so the honest choice is to make no claim rather than a stale one. If the
* upstream ever starts requiring it, the desktop client will necessarily send it
* and the value can be copied from there.
*
* A malformed URL is returned unchanged rather than throwing: a login page that
* opens is strictly better than a hard failure, and the upstream is the authority
* on what it issued.
*
* @param authUrl - the URL the state endpoint returned.
* @returns the URL with `loginSessionId` present.
*/
function officialAuthUrl(authUrl) {
	let parsed;
	try {
		parsed = new URL(authUrl);
	} catch {
		return authUrl;
	}
	if (!parsed.searchParams.has("loginSessionId")) parsed.searchParams.set("loginSessionId", randomUUID());
	return parsed.href;
}
/** Authorization has not completed yet — retryable, not a fault. */
var LoginPendingError = class extends Error {
	constructor(message = "登录尚未完成：请先在浏览器里完成授权，再重试。") {
		super(message);
		this.name = "LoginPendingError";
	}
};
/** Sign-in has not started or the state expired — the caller must restart. */
var LoginExpiredError = class extends Error {
	constructor(message = "授权状态已失效，请重新发起登录。") {
		super(message);
		this.name = "LoginExpiredError";
	}
};
/** Headers every login call sends. */
function loginHeaders(origin, token) {
	return {
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		Origin: origin,
		Referer: `${origin}/`,
		"User-Agent": LOGIN_USER_AGENT,
		...token !== void 0 && token !== "" ? { Authorization: `Bearer ${token}` } : {}
	};
}
/**
* Drives the device-code flow.
*
* The three calls are split rather than wrapped in one `login()` because the
* browser step happens between `begin` and `poll`, and a slash command must be
* able to print the URL, return, and poll on the user's next invocation.
*/
var LoginClient = class {
	fetchImpl;
	timeoutMs;
	now;
	minPollIntervalMs;
	loginTtlMs;
	/**
	* Live attempts, keyed by state.
	*
	* Tracking these locally is what makes the safety rules enforceable: the TTL
	* needs a creation time, the cadence floor needs a last-poll time, and
	* knowing the region a state belongs to is what stops a poll from being sent
	* to the wrong region's host (which the upstream would see as a token for one
	* service being redeemed at another).
	*/
	pending = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 3e4;
		this.now = options.now ?? (() => Date.now());
		this.minPollIntervalMs = options.minPollIntervalMs ?? 3e3;
		this.loginTtlMs = options.loginTtlMs ?? 6e5;
	}
	/**
	* Perform one JSON call and unwrap the envelope.
	*
	* @throws LoginPendingError - upstream says the user has not authorized yet.
	* @throws Error - any other failure, including a malformed body.
	*/
	async call(url, region, init) {
		const { origin } = regionEndpoints(region);
		let response;
		try {
			response = await this.fetchImpl(url, {
				method: init.method,
				headers: loginHeaders(origin, init.token),
				...init.body !== void 0 ? { body: init.body } : {},
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (error) {
			throw new Error(`请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const text = await response.text().catch(() => "");
		let envelope;
		try {
			envelope = JSON.parse(text);
		} catch {
			throw new Error(`上游返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
		}
		if (envelope.code !== void 0 && envelope.code !== 0) {
			const detail = `code=${envelope.code} msg=${envelope.msg ?? ""}`;
			const msg = envelope.msg ?? "";
			if (envelope.code === 11217 || msg.includes("login ing") || response.status >= 400 && response.status < 500) throw new LoginPendingError(`登录尚未完成（${detail}）`);
			throw new Error(detail);
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`);
		if (envelope.data === void 0) throw new Error(`上游响应缺少 data 字段：${text.slice(0, 200)}`);
		return envelope.data;
	}
	/** Step 1 — ask the upstream for a `state` and the authorization URL. */
	async begin(region) {
		const { loginBase } = regionEndpoints(region);
		const data = await this.call(`${loginBase}/v2/plugin/auth/state?platform=${AUTH_PLATFORM}`, region, {
			method: "POST",
			body: "{}"
		});
		if (typeof data.state !== "string" || data.state === "") throw new Error("上游未返回 state，登录无法继续。");
		if (typeof data.authUrl !== "string" || data.authUrl === "") throw new Error("上游未返回 authUrl，登录无法继续。");
		this.pending.set(data.state, {
			region,
			createdAt: this.now()
		});
		return {
			region,
			state: data.state,
			url: officialAuthUrl(data.authUrl)
		};
	}
	/**
	* Resolve a state to its live attempt, enforcing the lifetime.
	*
	* @throws LoginExpiredError - unknown state, or past {@link LOGIN_TTL_MS}.
	*/
	requirePending(state) {
		const entry = this.pending.get(state);
		if (entry === void 0) throw new LoginExpiredError("未知的登录状态：可能已过期，请重新发起登录。");
		if (this.now() - entry.createdAt > this.loginTtlMs) {
			this.pending.delete(state);
			throw new LoginExpiredError("登录窗口已超时，请重新发起登录。");
		}
		return entry;
	}
	/**
	* Step 2 — poll for the token.
	*
	* The region is taken from the recorded attempt rather than a caller
	* argument, so a state can only ever be redeemed at the host that issued it.
	* `workbuddy2api` stores the realm alongside the state for exactly this
	* reason (its `validateRealmMatch`).
	*
	* @throws LoginExpiredError - unknown or timed-out state.
	* @throws LoginPendingError - polled again too soon, or the user has not
	*   finished authorizing.
	*/
	async poll(state) {
		const entry = this.requirePending(state);
		const sinceLast = entry.lastPolledAt === void 0 ? void 0 : this.now() - entry.lastPolledAt;
		if (sinceLast !== void 0 && sinceLast < this.minPollIntervalMs) {
			const waitMs = this.minPollIntervalMs - sinceLast;
			throw new LoginPendingError(`轮询过于频繁，请等待约 ${Math.ceil(waitMs / 1e3)} 秒后再试（避免触发上游风控）。`);
		}
		entry.lastPolledAt = this.now();
		const region = entry.region;
		const { loginBase } = regionEndpoints(region);
		const data = await this.call(`${loginBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, region, { method: "GET" });
		if (typeof data.accessToken !== "string" || data.accessToken === "") throw new LoginPendingError("登录尚未完成：token 端点还没有返回 accessToken。");
		return {
			accessToken: data.accessToken,
			refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : "",
			expiresIn: typeof data.expiresIn === "number" && Number.isFinite(data.expiresIn) ? data.expiresIn : 0,
			domain: typeof data.domain === "string" ? data.domain : ""
		};
	}
	/** Step 3 — read the account identity bound to this authorization. */
	async account(state, accessToken) {
		const entry = this.requirePending(state);
		const { loginBase } = regionEndpoints(entry.region);
		const data = await this.call(`${loginBase}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, entry.region, {
			method: "GET",
			token: accessToken
		});
		return {
			uid: typeof data.uid === "string" ? data.uid : "",
			enterpriseId: typeof data.enterpriseId === "string" ? data.enterpriseId : "",
			nickname: typeof data.nickname === "string" ? data.nickname : ""
		};
	}
	/**
	* Poll and read the account in one step, then retire the state.
	*
	* The state is deleted only on success: a pending result must leave it in
	* place so the user can come back and poll again after finishing in the
	* browser.
	*
	* @throws LoginExpiredError - unknown or timed-out state.
	* @throws LoginPendingError - authorization has not completed.
	* @throws Error - the token arrived but carries no `uid`, which makes the
	*   credential unusable (every upstream call needs it).
	*/
	async complete(state) {
		const entry = this.requirePending(state);
		const token = await this.poll(state);
		const account = await this.account(state, token.accessToken);
		if (account.uid === "") throw new Error("上游未返回 uid，无法确定账号身份。");
		this.pending.delete(state);
		return {
			region: entry.region,
			token,
			account
		};
	}
};
/** Normalize a user-supplied region argument, accepting `1`/`cn`/`2`/`global`. */
function parseRegionInput(input) {
	switch (input.trim().toLowerCase()) {
		case "":
		case "1":
		case "cn":
		case "国内":
		case "国内版": return "cn";
		case "2":
		case "global":
		case "国际":
		case "国际版": return "global";
		default: return;
	}
}
//#endregion
//#region src/version.ts
/** Version of this plugin, as published in package.json. */
const PLUGIN_VERSION = "0.0.2";
/** Gap between polls. Matches the flow's observed pace and stays above the client's own floor. */
const POLL_INTERVAL_MS = 3e3;
/** The option label that means "I finished in the browser". */
const CONFIRM_LABEL = "已完成授权，继续";
/** Sleep, abortable so a cancelled command stops waiting promptly. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(/* @__PURE__ */ new Error("已取消"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error("已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Format a token expiry for display, plus a coarse "time left" hint. */
function describeExpiry(credential, now = Date.now()) {
	const remainingMs = credential.expiresAtMs - now;
	if (remainingMs <= 0) return "已过期（下次使用时会自动刷新）";
	const minutes = Math.floor(remainingMs / 6e4);
	if (minutes < 60) return `约 ${minutes} 分钟后可刷新`;
	return `约 ${Math.floor(minutes / 60)} 小时内有效`;
}
/**
* Render the account list, shared by `/wb-status` and the post-login summary.
*
* @param credentials - Accounts to show.
* @param disabled - Disabled account uids, marking entries excluded from selection.
* @param now - Current epoch milliseconds.
*/
function renderAccounts(credentials, disabled = /* @__PURE__ */ new Set(), now = Date.now()) {
	if (credentials.length === 0) return "当前没有已登录的账号。执行 /wb-login 开始登录。";
	const lines = credentials.map((credential, index) => {
		const label = displayNameOf(credential);
		const region = regionEndpoints(credential.region).label;
		const state = disabled.has(credential.uid) ? "（已停用）" : "";
		return `  ${index + 1}. ${label} · ${region} · ${describeExpiry(credential, now)}${state}`;
	});
	return [`已登录 ${credentials.length} 个账号：`, ...lines].join("\n");
}
/**
* Prompt for the authorization link and wait for the user's confirmation.
*
* @returns `true` when the user says they finished; `false` when they dismissed
*   it. Throws only on a real failure.
*/
async function confirmAuthorization(url, region, agent, deps) {
	const service = deps.userQuestions;
	if (service === void 0) return {
		confirmed: false,
		fallbackText: [
			`请在浏览器中打开以下链接完成${regionEndpoints(region).label}授权：`,
			"",
			`  ${url}`,
			"",
			"授权完成后，重新执行 /wb-login 以完成登录（授权链接每次都会重新生成）。"
		].join("\n")
	};
	try {
		return { confirmed: (await service.ask({
			questions: [{
				id: "workbuddy-authorize",
				question: "请在浏览器中打开链接完成授权，完成后选择下方选项：",
				header: "账号授权",
				detail: `${url}\n\n（${regionEndpoints(region).label} · 链接由上游签发，仅用于本次登录）`,
				options: [{
					label: CONFIRM_LABEL,
					description: "上游确认后凭证会自动保存并刷新模型列表"
				}]
			}],
			agent
		})).answers[0]?.selected[0] === CONFIRM_LABEL };
	} catch (error) {
		deps.warn("无法弹出授权确认框，改用文本提示", error);
		return {
			confirmed: false,
			fallbackText: [
				"无法弹出确认框（当前上下文没有可用的交互界面）。",
				"",
				`请在浏览器中打开：${url}`,
				"",
				"授权完成后重新执行 /wb-login。"
			].join("\n")
		};
	}
}
/**
* Register the plugin's commands.
*
* @param ctx - Plugin context; `commands` must be available.
* @param logins - The plugin's login client.
* @param deps - Injected collaborators.
* @returns The disposers for every registration.
*/
function registerCommands(ctx, logins, deps) {
	const disposers = [];
	const commands = ctx.commands;
	/** `/wb-login [cn|global]` — begin and complete a sign-in. */
	disposers.push(commands.register({
		name: "wb-login",
		description: "登录 WorkBuddy 账号（不依赖桌面 App）",
		input: { hint: "[cn | global]" },
		handler: async ({ rawInput, agent, signal }) => {
			const trimmed = rawInput.trim();
			const region = parseRegionInput(trimmed);
			if (trimmed !== "" && region === void 0) return {
				kind: "error",
				text: `无法识别参数「${trimmed}」。用法：/wb-login [cn | global]（不带参数默认国内版）`
			};
			const target = region ?? "cn";
			let url;
			let state;
			try {
				const request = await logins.begin(target);
				url = request.url;
				state = request.state;
			} catch (error) {
				return {
					kind: "error",
					text: `无法向上游申请授权链接：${error instanceof Error ? error.message : String(error)}\n（该步骤需要访问 ${regionEndpoints(target).base}）`
				};
			}
			const confirm = await confirmAuthorization(url, target, agent, deps);
			if (confirm.fallbackText !== void 0) return {
				kind: "error",
				text: confirm.fallbackText
			};
			if (!confirm.confirmed) return {
				kind: "success",
				text: "已取消授权，未写入任何凭据。"
			};
			let lastError;
			for (let attempt = 1; attempt <= 20; attempt += 1) try {
				const result = await deps.complete(state);
				const accounts = await listCredentials();
				const disabled = await disabledUids();
				return {
					kind: "success",
					text: [
						`登录成功：${result.label}`,
						"",
						renderAccounts(accounts, disabled),
						"",
						"模型列表已刷新，可在模型选择器中选择 WorkBuddy 模型。"
					].join("\n")
				};
			} catch (error) {
				lastError = error;
				if (!(error instanceof LoginPendingError)) break;
				if (attempt < 20) try {
					await sleep(POLL_INTERVAL_MS, signal);
				} catch {
					return {
						kind: "error",
						text: "登录已取消。"
					};
				}
			}
			if (lastError instanceof LoginPendingError) return {
				kind: "error",
				text: `等待授权超时（约 ${Math.round(POLL_INTERVAL_MS * 20 / 1e3)} 秒内上游始终未确认）。\n请确认浏览器中已完成授权并看到成功提示，然后重新执行 /wb-login（链接每次重新生成）。`
			};
			if (lastError instanceof LoginExpiredError) return {
				kind: "error",
				text: `${lastError.message}请重新执行 /wb-login。`
			};
			return {
				kind: "error",
				text: `登录失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
			};
		}
	}));
	/** `/wb-status` — accounts and plugin state. */
	disposers.push(commands.register({
		name: "wb-status",
		description: "查看已登录的 WorkBuddy 账号与插件状态",
		handler: async () => {
			const credentials = await listCredentials();
			const disabled = await disabledUids();
			return {
				kind: "success",
				text: [
					`dsh-workbuddy-oauth v${PLUGIN_VERSION}`,
					"",
					renderAccounts(credentials, disabled)
				].join("\n")
			};
		}
	}));
	/** `/wb-logout [uid]` — remove a stored credential. */
	disposers.push(commands.register({
		name: "wb-logout",
		description: "退出登录（仅删除本插件保存的凭据，不影响上游账号）",
		input: { hint: "[uid 前缀]" },
		handler: async ({ rawInput }) => {
			const credentials = await listCredentials();
			if (credentials.length === 0) return {
				kind: "success",
				text: "当前没有已登录的账号。"
			};
			const selector = rawInput.trim();
			const target = selector === "" ? credentials.length === 1 ? credentials[0] : void 0 : credentials.find((credential) => credential.uid.startsWith(selector));
			if (target === void 0) return {
				kind: "error",
				text: [
					selector === "" ? "存在多个账号，请指定要退出的 uid 前缀：" : `没有匹配「${selector}」的账号。`,
					"",
					renderAccounts(credentials, await disabledUids()),
					"",
					"用法：/wb-logout <uid 前缀>"
				].join("\n")
			};
			const label = displayNameOf(target);
			await deps.remove(target.uid);
			const remaining = await listCredentials();
			return {
				kind: "success",
				text: [
					`已退出：${label}`,
					"",
					remaining.length === 0 ? "已无登录账号，模型分组将在下次刷新后消失。" : renderAccounts(remaining, await disabledUids())
				].join("\n")
			};
		}
	}));
	/** `/wb-account [enable|disable] [uid 前缀]` — list and toggle accounts. */
	disposers.push(commands.register({
		name: "wb-account",
		description: "管理 WorkBuddy 账号（列出 / 启用 / 停用）",
		input: { hint: "[enable | disable] [uid 前缀]" },
		handler: async ({ rawInput }) => {
			const [verb, selectorRaw] = rawInput.trim().split(/\s+/);
			const selector = selectorRaw?.trim() ?? "";
			if (verb === void 0 || verb === "") return {
				kind: "success",
				text: renderAccounts(await listCredentials(), await disabledUids())
			};
			if (verb !== "enable" && verb !== "disable") return {
				kind: "error",
				text: `无法识别动作「${verb}」。用法：/wb-account [enable | disable] <uid 前缀>（不带动作则列出全部账号）`
			};
			const credentials = await listCredentials();
			if (credentials.length === 0) return {
				kind: "success",
				text: "当前没有已登录的账号。执行 /wb-login 开始登录。"
			};
			const target = selector === "" ? credentials.length === 1 ? credentials[0] : void 0 : credentials.find((credential) => credential.uid.startsWith(selector));
			if (target === void 0) return {
				kind: "error",
				text: [
					selector === "" ? "存在多个账号，请指定要操作的 uid 前缀：" : `没有匹配「${selector}」的账号。`,
					"",
					renderAccounts(credentials, await disabledUids()),
					"",
					"用法：/wb-account <enable | disable> <uid 前缀>"
				].join("\n")
			};
			const disabled = await setAccountDisabled(target.uid, verb === "disable");
			const label = displayNameOf(target);
			return {
				kind: "success",
				text: [
					`${verb === "disable" ? "已停用" : "已启用"}：${label}`,
					"",
					renderAccounts(credentials, disabled)
				].join("\n")
			};
		}
	}));
	return disposers;
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. The plan this
* implements (`docs/reasoning-effort-probe-plan.md` §5) requires that a result
* is invalidated whenever the model's catalog row changes, so every record
* carries a fingerprint of the fields the probe depended on.
*
* The file lives beside the plugin's own credential copy under `$DSH_HOME`,
* never in the desktop app's files, and carries no token, prompt, or response
* body — only model ids, effort spellings, and timestamps.
*
* @module dsh-workbuddy-oauth/probe-store
*/
/** Basename of the probe record inside the Harness home. */
const WORKBUDDY_PROBE_FILENAME = ".workbuddy-probe.json";
/**
* On-disk format this reader accepts; other versions are discarded.
*
* Version 2 nested the records under the account that produced them
* (`records[account][modelId]`), so two accounts no longer overwrite each
* other's observations for the same model. Version 1 files (flat, one record
* per model) are deliberately not migrated: they read as empty and the
* affected models are re-probed on demand, which keeps the reader free of
* half-understood compatibility paths.
*/
const PROBE_FORMAT_VERSION = 2;
/**
* How long an observation stays usable. Conservative on purpose: the plan's
* whole argument is that upstream metadata moves fast, so a result that has
* outlived its fingerprint's usefulness should not quietly keep granting a
* picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/**
* Plugin-owned probe record path inside the Harness home.
*
* One file per variant. Same-named models exist on both endpoints (the
* international catalog repeats `glm-5.3`, `glm-5.2`, `hy3`, `kimi-k2.6`), and
* {@link fingerprintModel} covers only `id`/`reasoning`/`supportsImages` —
* never the provider — so a single shared file would let one variant's
* observation answer for the other. The paths differ; the format does not.
*/
function workbuddyProbePath(filename = WORKBUDDY_PROBE_FILENAME) {
	return join(resolveDshHome(), filename);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a promo badge does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	if (typeof wrapped["account"] !== "string" || wrapped["account"] === "") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, keyed by the
* account that produced each observation, and never trusted across a
* fingerprint change or past the TTL.
*/
var WorkBuddyProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? workbuddyProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [account, bucket] of Object.entries(document?.records ?? {})) {
				if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) continue;
				const parsed = {};
				for (const [modelId, record] of Object.entries(bucket)) if (isRecord(record)) parsed[modelId] = record;
				records[account] = parsed;
			}
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for one account and model, or `undefined` when there is
	* none, it is expired, it was taken against a different catalog row, or it
	* belongs to a different account.
	*
	* @param account - the account in effect, as `uid:enterpriseId`. Records are
	*   only returned for the account that produced them.
	*/
	get(modelId, fingerprint, account) {
		const record = this.load()[account]?.[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (record.account !== account) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation under the account stamped on it. Only a decisive
	* answer (`validating` / `non-validating`) replaces an existing decisive
	* record *of the same account*: a transient `unknown` must not erase
	* knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const bucket = records[record.account] ?? (records[record.account] = {});
		const existing = bucket[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		bucket[modelId] = record;
		this.persist();
	}
	/** Drop every record of every account; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/**
	* Drop one account's records.
	*
	* Called when an account is removed. A record is keyed by `uid:enterpriseId`
	* and carries that identity inside itself, so leaving it behind would keep a
	* removed account's identifier on disk — and if the same account signed in
	* again, a stale observation could answer for it.
	*
	* @param account - the account key, as `uid:enterpriseId`.
	* @returns whether any record was removed.
	*/
	forget(account) {
		const records = this.load();
		if (records[account] === void 0) return false;
		delete records[account];
		this.persist();
		return true;
	}
	/** Every record currently held, grouped by account, for status display. */
	all() {
		const records = this.load();
		return Object.fromEntries(Object.entries(records).map(([account, bucket]) => [account, { ...bucket }]));
	}
	/** Build a record stamped with this store's clock, version, and account. */
	record(fingerprint, validation, efforts, account) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion,
			account
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var WorkBuddyProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* Applies the plan's precedence: a declared set always wins, so a model that
	* declares `supportedEfforts` is never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		const account = this.options.account();
		if (account === void 0) return void 0;
		return this.options.store.get(modelId, fingerprintModel(info), account);
	}
	/**
	* Whether a model can be probed by hand: it reasons and the upstream
	* declares no effort set for it.
	*
	* Deliberately *not* filtered by whether a result already exists. Dropping a
	* model once it has been detected made the list shrink with use, so
	* re-detecting one model — after an upstream change, say — meant clearing
	* every other result first.
	*/
	isCandidate(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return false;
		if (info.reasoning?.supports !== true) return false;
		return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const account = this.options.account();
		if (account === void 0) return {
			state: "unavailable",
			reason: "no WorkBuddy credential"
		};
		const pendingKey = JSON.stringify([account, modelId]);
		const pending = this.pending.get(pendingKey);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			if (this.options.account() !== account) return {
				state: "unavailable",
				reason: "account changed before detection"
			};
			const credential = await this.options.credentials.current();
			if (credential === void 0) return {
				state: "unavailable",
				reason: "no WorkBuddy credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(credential, modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					region: this.options.region,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				if (this.options.account() !== account) return {
					state: "unavailable",
					reason: "account changed during detection"
				};
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts, account);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(pendingKey, run);
		try {
			return await run;
		} finally {
			this.pending.delete(pendingKey);
		}
	}
};
//#endregion
//#region src/status-paths.ts
/** Read-only status endpoint consumed by this plugin's browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-oauth/status";
/**
* State-changing control endpoint.
*
* Separate from the status route because it accepts writes. The status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing an action — any local process can write
* `Host: 127.0.0.1`. A route that spends the user's credit therefore also
* requires the in-process key handed to the browser with the status document.
*
* **One path per region, and that is a correctness requirement, not tidiness.**
* The two regions each own a probe store and a probe service, and
* `webServer.register` *throws* on a duplicate path — so registering both at one
* path would abort the second registration and, with it, that region's control
* surface. The browser reaches the right one because the card knows which region
* a model belongs to before it asks to probe it.
*
* Literal strings rather than a computed suffix: the two halves are built
* independently, and a shared *expression* is one build-config drift away from
* the card asking a route the host never mounted.
*/
const WORKBUDDY_CONTROL_PATH = "/plugins/dsh-workbuddy-oauth/control";
/** Control endpoint for the international region. */
const WORKBUDDY_AI_CONTROL_PATH = "/plugins/dsh-workbuddy-oauth/ai/control";
/** The control path for one region. */
function controlPathFor(region) {
	return region === "global" ? WORKBUDDY_AI_CONTROL_PATH : WORKBUDDY_CONTROL_PATH;
}
/** Header carrying the in-process control key on a control request. */
const WORKBUDDY_CONTROL_KEY_HEADER = "x-workbuddy-oauth-key";
//#endregion
//#region src/control-route.ts
/**
* The plugin's state-changing control route.
*
* Two guards, because they stop different things:
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card through the status document. Loopback alone is *not*
*    authentication — any local process can write `Host: 127.0.0.1` — so a
*    route that spends the user's credit must prove the caller was told the
*    key.
*
* A probe request is never accepted with a prompt, a model id outside the live
* catalog, or a sentinel from the browser: it is assembled entirely host-side.
*
* Ported from `dsh-workbuddy-connect` (MIT), reduced to the actions this plugin
* actually offers — the visibility and context-window actions belong to phases
* this plugin has not reached, and carrying their branches would mean shipping
* routes that answer 404 by construction.
*
* @module dsh-workbuddy-oauth/control-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createControlKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
	if (action === "login-begin") {
		const region = wrapped["region"];
		if (region !== "cn" && region !== "global") return void 0;
		return {
			action: "login-begin",
			region
		};
	}
	if (action === "login-complete") {
		const state = wrapped["state"];
		if (typeof state !== "string" || state.trim() === "") return void 0;
		return {
			action: "login-complete",
			state: state.trim()
		};
	}
	if (action === "logout") {
		const uid = wrapped["uid"];
		if (typeof uid !== "string" || uid.trim() === "") return void 0;
		return {
			action: "logout",
			uid: uid.trim()
		};
	}
	if (action === "set-account-enabled") {
		const uid = wrapped["uid"];
		if (typeof uid !== "string" || uid.trim() === "") return void 0;
		const enabled = wrapped["enabled"];
		if (typeof enabled !== "boolean") return void 0;
		return {
			action: "set-account-enabled",
			uid: uid.trim(),
			enabled
		};
	}
	if (action === "set-model-visible") {
		const region = wrapped["region"];
		if (region !== "cn" && region !== "global") return void 0;
		const modelId = wrapped["modelId"];
		if (typeof modelId !== "string" || modelId.trim() === "") return void 0;
		const visible = wrapped["visible"];
		if (typeof visible !== "boolean") return void 0;
		return {
			action: "set-model-visible",
			region,
			modelId: modelId.trim(),
			visible
		};
	}
	if (action === "set-maximum-context-window") {
		const enabled = wrapped["enabled"];
		if (typeof enabled !== "boolean") return void 0;
		return {
			action: "set-maximum-context-window",
			enabled
		};
	}
	if (action === "refresh-credits") {
		const uid = wrapped["uid"];
		if (typeof uid !== "string" || uid.trim() === "") return void 0;
		return {
			action: "refresh-credits",
			uid: uid.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare server
* with a known key.
*/
function workBuddyControlHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-workbuddy-oauth-key"])) {
			json$1(res, 403, { error: "invalid-control-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json$1(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json$1(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "clear") {
				deps.clear();
				json$1(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					json$1(res, 404, { error: "refresh-not-supported" });
					return;
				}
				json$1(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "login-begin") {
				if (deps.loginBegin === void 0) {
					json$1(res, 404, { error: "login-not-supported" });
					return;
				}
				json$1(res, 200, await deps.loginBegin(action.region));
				return;
			}
			if (action.action === "login-complete") {
				if (deps.loginComplete === void 0) {
					json$1(res, 404, { error: "login-not-supported" });
					return;
				}
				json$1(res, 200, await deps.loginComplete(action.state));
				return;
			}
			if (action.action === "logout") {
				if (deps.logout === void 0) {
					json$1(res, 404, { error: "logout-not-supported" });
					return;
				}
				json$1(res, 200, await deps.logout(action.uid));
				return;
			}
			if (action.action === "set-account-enabled") {
				if (deps.setAccountEnabled === void 0) {
					json$1(res, 404, { error: "account-toggle-not-supported" });
					return;
				}
				json$1(res, 200, await deps.setAccountEnabled(action.uid, action.enabled));
				return;
			}
			if (action.action === "set-model-visible") {
				if (deps.setModelVisible === void 0) {
					json$1(res, 404, { error: "model-visibility-not-supported" });
					return;
				}
				json$1(res, 200, await deps.setModelVisible(action.region, action.modelId, action.visible));
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					json$1(res, 404, { error: "context-window-not-supported" });
					return;
				}
				json$1(res, 200, await deps.setMaximumContextWindow(action.enabled));
				return;
			}
			if (action.action === "refresh-credits") {
				if (deps.refreshCredits === void 0) {
					json$1(res, 404, { error: "credits-not-supported" });
					return;
				}
				json$1(res, 200, await deps.refreshCredits(action.uid));
				return;
			}
			json$1(res, 200, await deps.probe(action.model));
		} catch (error) {
			json$1(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST control route on an optional webServer context. */
function registerWorkBuddyControlRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-oauth/control";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyControlHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-oauth: control route");
}
//#endregion
//#region src/web-status.ts
/** Accounts, grouped by region, as the card displays them. */
function accountViews(credentials, disabled) {
	return credentials.map((credential) => ({
		uid: credential.uid,
		label: displayNameOf(credential),
		region: credential.region,
		expiresAtMs: credential.expiresAtMs,
		enabled: !disabled.has(credential.uid)
	}));
}
/** One model's display fields. */
function modelViews(models) {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		multiWindow: (model.supportedContextWindows?.length ?? 0) > 1
	}));
}
/** One region's slice of the document. */
function regionView(view, signedIn) {
	const models = view.models();
	const byId = new Map(models.map((model) => [model.id, model]));
	return {
		region: view.region,
		label: regionEndpoints(view.region).label,
		controlPath: controlPathFor(view.region),
		providerId: view.providerId,
		signedIn,
		models: modelViews(models),
		hiddenModels: [...view.hiddenModels()],
		useMaximumContextWindow: view.useMaximumContextWindow(),
		probeRunning: view.probeRunning(),
		probeCandidates: [...view.probeCandidates()],
		probeResults: view.probeResults().flatMap(({ id, record }) => {
			const info = byId.get(id);
			return info === void 0 ? [] : [{
				id,
				name: info.name,
				validation: record.validation,
				efforts: record.efforts,
				probedAt: record.probedAtMs
			}];
		}).sort((a, b) => b.probedAt - a.probedAt)
	};
}
/** Assemble the document. */
async function workBuddyWebStatus(options) {
	const credentials = await (options.credentials ?? listCredentials)();
	const disabled = await (options.disabled ?? disabledUids)();
	const signedInRegions = new Set(credentials.map((credential) => credential.region));
	return {
		status: "ok",
		version: PLUGIN_VERSION,
		accounts: accountViews(credentials, disabled),
		regions: options.regions.map((view) => regionView(view, signedInRegions.has(view.region))),
		controlKey: options.controlKey
	};
}
/** Write a JSON response. */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json(res, 200, await workBuddyWebStatus(deps));
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_STATUS_PATH,
			handler: workBuddyStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-oauth: status route");
}
//#endregion
//#region src/fingerprint.ts
/**
* Stable device fingerprint derivation.
*
* ## Why this exists
*
* The upstream treats requests as coming from a physical device. A client that
* invents a fresh machine id per process, or that sends none at all, looks like
* a new device every launch — the pattern upstream risk control is built to
* flag, and the one that gets multi-account setups correlated and blocked.
*
* The fix every mature project in this space converged on is the same:
* **derive the id deterministically from the account uid**, so each account
* always presents as one fixed device and different accounts present as
* different devices. Same uid plus same purpose yields the same id forever,
* across restarts and machines.
*
* ## Provenance
*
* The scheme (`md5("<salt>:<uid>")` truncated to 36 hex chars, with distinct
* salts per purpose) matches the reference implementations this plugin is
* modelled on — `workbuddy2api`'s `derive_id`, as carried by
* `ardeyouxipianyi/workbuddy2api-hub` and rebuilt for Rust in
* `NextAgentX/trae-workbuddy-switch`. Reusing the established derivation is
* deliberate: it is what upstream has been serving without issue.
*
* ## Scope: fingerprints are NOT for the login flow
*
* Checked against all three reference implementations: the OAuth calls
* (`auth/state`, `auth/token`, `login/account`) carry **only** the CLI user
* agent and the region's `Origin`/`Referer`. No `X-Machine-ID`, no
* `X-Session-ID`. Device headers appear on chat, billing and task endpoints.
*
* So this module is applied to outbound API calls and *not* to sign-in, which
* also keeps a sign-in from being tied to a device identity it does not need.
*
* @module dsh-workbuddy-oauth/fingerprint
*/
/**
* Namespace prefix for derived ids. Changing it would change every id, which
* upstream would read as every account moving to a new device — leave it alone.
*/
const ID_NAMESPACE = "wb2a";
/**
* Length in hex characters of a derived id.
*
* MD5 yields 16 bytes, i.e. 32 hex characters. The reference project this
* follows writes `md5(...).hexdigest()[:36]`, whose `[:36]` is a no-op on a
* 32-character string — the whole digest is used, and that is what upstream
* has been served. (A sibling Rust implementation uses SHA-256 truncated to
* 18 bytes, also producing 36; the two differ, and this plugin follows the
* MD5 line because the values observed working upstream come from it.)
*
* The value is asserted in tests, so this constant cannot drift unnoticed.
*/
const DERIVED_ID_HEX_LENGTH = 32;
/**
* Derive a stable identifier for one account and purpose.
*
* The uid is required: without one there is no stable basis, and returning a
* constant would make every account share a device. Callers must therefore
* skip the header entirely when the uid is empty, which is why this returns
* `undefined` rather than a placeholder.
*
* @param purpose - What the id is for; `machine` and `session` are sent
*   upstream. Distinct purposes must not collide, so the value is part of the
*   hash input.
* @param uid - The account's uid from the OAuth account endpoint.
* @returns Hex characters of {@link DERIVED_ID_HEX_LENGTH}, or `undefined` when
*   there is no uid.
*/
function deriveId(purpose, uid) {
	if (uid === "") return void 0;
	return createHash("md5").update(`${ID_NAMESPACE}:${purpose}:${uid}`, "utf8").digest("hex").slice(0, DERIVED_ID_HEX_LENGTH);
}
/**
* Build the device identity headers for one account.
*
* @returns The headers, or an empty object when `uid` is empty — sending a
*   blank header is worse than sending none, because upstream would record a
*   device with no identity.
*/
function deviceHeaders(uid) {
	const machine = deriveId("machine", uid);
	const session = deriveId("session", uid);
	if (machine === void 0 || session === void 0) return {};
	return {
		"X-Machine-ID": machine,
		"X-Session-ID": session
	};
}
/**
* Derive a stable prefix for request ids.
*
* Upstream aggregates a conversation turn by request id. A random id per call
* fragments one turn into many, which is visible in billing and is the symptom
* the reference projects fixed with a stable prefix.
*/
function requestIdPrefix(uid) {
	return deriveId("req", uid) ?? "wb2a-anonymous";
}
/**
* A request id carrying a stable per-account prefix plus a unique suffix.
*
* @param uid - Account uid; an empty uid yields a shared `anonymous` prefix,
*   which is acceptable here because the id still has to be unique per call.
* @param now - Current epoch milliseconds, injectable for tests.
*/
function requestId(uid, now = Date.now()) {
	const suffix = String(now % 1e6).padStart(6, "0");
	return `${requestIdPrefix(uid)}-${suffix}`;
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddy-oauth";
/** The model registry required before the provider can register. */
const inject = ["llm", "commands"];
/**
* Provider ids.
*
* **Namespaced deliberately, and not `workbuddy` / `workbuddy-ai`.** An adapter
* is registered per provider id and a duplicate is a hard error
* (`an adapter for provider "workbuddy" is already registered`), so a plain
* `workbuddy` collides with `dsh-workbuddy-connect` — which claims exactly those
* two ids — and makes this plugin's models silently unavailable whenever both
* are installed. That is the expected setup for migration, so the collision is
* not hypothetical: it happened on the first install.
*
* The prefix also keeps the two plugins' model groups distinguishable in the
* picker, which is what a user comparing them needs.
*/
const WORKBUDDY_PROVIDER = "workbuddy-oauth";
/** Provider id for the international region. */
const WORKBUDDY_AI_PROVIDER = "workbuddy-oauth-ai";
/**
* Provider id for one region.
*
* Two ids, not one: the upstreams advertise overlapping model ids, and a single
* provider id would make the descriptor for a model depend on which region
* happened to register last.
*/
function providerIdFor(region) {
	return region === "global" ? WORKBUDDY_AI_PROVIDER : WORKBUDDY_PROVIDER;
}
/** Stream idle timeout, matching the ported client's expectations. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Whether *automatic* reasoning-effort probing is authorized.
*
* **Permanently `false`, and that is a deliberate policy rather than an
* unfinished setting.** A probe spends the user's credit, so the upstream
* project's own design rule is that a sweep runs only when the user asks for it.
* The control route therefore calls `probe(modelId, true)` — per-click manual
* consent — and this gate exists so that any *future* automatic trigger has to
* come through a deliberate decision instead of inheriting permission by
* default.
*
* Do not wire a settings toggle to this without revisiting that rule.
*/
const AUTOMATIC_PROBING_AUTHORIZED = false;
/** How often to re-read credentials to notice a sign-in that happened while running, in ms. */
const CREDENTIAL_POLL_MS = 15e3;
const Config = z.object({
	appVersion: z.string().default(""),
	cliVersion: z.string().default(""),
	region: z.string().default("cn")
});
/**
* The stable identity key for a credential, or `undefined` when it has no uid.
*
* `enterpriseId` joins the uid because the same user id can exist in two
* enterprises, and a probe observation (an entitlement fact) must not cross
* between them. A uid-less credential yields `undefined` rather than a
* `":enterpriseId"` key that every uid-less account would silently share.
*/
function accountIdentityOf(credential) {
	if (credential === void 0 || credential.uid === "") return void 0;
	return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
/**
* Pick the fallback roster for a region.
*
* Used only until the first successful fetch; the live catalog replaces it.
*/
function fallbackFor(region) {
	return region === "global" ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS;
}
/** Build one region's runtime. */
function createRegionRuntime(region, identity, consent) {
	const client = new WorkBuddyUpstreamClient({ identity });
	const catalog = new WorkBuddyCatalog(fallbackFor(region));
	const store = createCredentialStore({ region });
	const probeStore = new WorkBuddyProbeStore({
		pluginVersion: PLUGIN_VERSION,
		path: probePathFor(region)
	});
	let account;
	return {
		region,
		client,
		catalog,
		store,
		probeStore,
		probeService: new WorkBuddyProbeService({
			store: probeStore,
			catalog,
			credentials: store,
			client,
			region,
			consent,
			account: () => account
		}),
		account: () => account,
		setAccount: (credential) => {
			account = accountIdentityOf(credential);
		},
		invalidate: () => {}
	};
}
/**
* Refresh one region's catalog from the upstream, if an account exists.
*
* Failures are swallowed into a log line: a network problem must not stop the
* provider from registering, and the fallback roster keeps working meanwhile.
*
* @param reason - Why the refresh is happening. A periodic poll passes
*   `'poll'` and stays quiet when nothing changed, so the log does not fill
*   with one identical line every interval; a user-triggered refresh (after a
*   sign-in) passes `'login'` and always reports, because the user is waiting
*   for exactly that confirmation.
* @returns whether the catalog changed (callers emit an adapter update then).
*/
async function refreshCatalog(ctx, runtime, log, reason = "poll") {
	const label = regionEndpoints(runtime.region).label;
	const credential = await runtime.store.current();
	runtime.setAccount(credential);
	if (credential === void 0) {
		const changed = runtime.catalog.setVisible(false);
		if (changed && reason !== "poll") log(`${label}：无可用账号，模型分组已隐藏。`);
		return changed;
	}
	const becameVisible = runtime.catalog.setVisible(true);
	try {
		const models = await runtime.client.fetchModels(credential);
		if (models.length === 0) {
			if (reason !== "poll") log(`${label}：上游返回空模型列表，保留内置回落表。`);
			return becameVisible;
		}
		const before = runtime.catalog.current().map((model) => model.id).join(",");
		runtime.catalog.set(models);
		const changed = before !== runtime.catalog.current().map((model) => model.id).join(",");
		if (changed || reason !== "poll") log(`${label}：已同步 ${models.length} 个模型。`);
		return changed || becameVisible;
	} catch (error) {
		log(`${label}：模型列表拉取失败，保留内置回落表（${error instanceof Error ? error.message : String(error)}）。`);
		return becameVisible;
	}
}
/**
* Plugin entry point.
*
* Wires one provider, its loopback shim, and the credential-driven catalog
* lifecycle. Nothing here reads the WorkBuddy desktop app.
*/
function apply(ctx, config) {
	const log = (message) => {
		ctx.logger.info(`dsh-workbuddy-oauth: ${message}`);
	};
	const identity = {
		...config.appVersion !== void 0 && config.appVersion !== "" ? { appVersion: config.appVersion } : {},
		...config.cliVersion !== void 0 && config.cliVersion !== "" ? { cliVersion: config.cliVersion } : {}
	};
	const runtimes = [createRegionRuntime("cn", identity, () => false), createRegionRuntime("global", identity, () => false)];
	/**
	* Apply the persisted hidden-model rule to each catalog.
	*
	* Loaded once at startup; the catalog's `setHiddenModels` is separate from the
	* roster (`set`), so a later catalog refresh cannot resurrect a hidden model.
	* The read is fire-and-forget — until it lands, the catalog simply shows the
	* full roster, which is the harmless default.
	*/
	readHiddenModels().then((hidden) => {
		for (const runtime of runtimes) runtime.catalog.setHiddenModels(new Set(hidden[runtime.region]));
	});
	/**
	* Apply the persisted maximum-context-window preference to every catalog.
	*
	* One flag shared across both regions (only the international roster declares
	* a larger window, so in practice only it changes); loaded once at startup,
	* fire-and-forget like the hidden set.
	*/
	readUseMaximumContextWindow().then((useMaximum) => {
		if (!useMaximum) return;
		let changed = false;
		for (const runtime of runtimes) if (runtime.catalog.setUseMaximumContextWindow(true)) changed = true;
		if (changed) ctx.emit("llm/adapters-updated");
	});
	/**
	* Live login attempts, keyed by state.
	*
	* Held here rather than in a module global so a profile reload cannot leave a
	* stale pending login behind.
	*/
	const logins = new LoginClient();
	/** Schedules outstanding, cleared on disposal. */
	const timers = [];
	let stopped = false;
	const shims = [];
	/**
	* Start one region's loopback endpoint, then register its provider.
	*
	* **Order matters**: the adapter reads the shim's origin while it is being
	* constructed, so the listener must already hold a port. Constructing first
	* throws `workbuddy shim has no listening address` and the whole entry fails
	* to activate. (Connect documents this at its own call site, which is why it
	* awaits `shim.ready` before building the adapter.)
	*/
	const startRegion = async (runtime) => {
		const { region } = runtime;
		const label = regionEndpoints(region).label;
		const shim = createWorkBuddyShim({
			store: runtime.store,
			client: runtime.client,
			catalog: runtime.catalog,
			logger: ctx.logger
		});
		shims.push(() => shim.close());
		try {
			await shim.ready;
		} catch (error) {
			ctx.logger.error(`dsh-workbuddy-oauth: ${label} 回环端点启动失败`, error);
			return;
		}
		try {
			const result = createWorkBuddyAdapter({
				providerId: providerIdFor(region),
				displayName: regionEndpoints(region).label,
				shim,
				store: runtime.store,
				catalog: runtime.catalog,
				resolveAttachments: () => ctx.get("attachments"),
				resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
				observe: (modelId) => runtime.probeService.recordFor(modelId)
			});
			const release = ctx.llm.registerAdapter([providerIdFor(region)], result.adapter);
			runtime.invalidate = () => {
				result.invalidate();
				ctx.emit("llm/adapters-updated");
			};
			try {
				ctx.effect(() => () => {
					release();
					shim.close();
				});
			} catch {
				release();
				shim.close();
			}
			if (await refreshCatalog(ctx, runtime, log, "startup")) result.invalidate();
			ctx.emit("llm/adapters-updated");
		} catch (error) {
			ctx.logger.error(`dsh-workbuddy-oauth: ${label} provider 注册失败`, error);
			shim.close();
		}
	};
	for (const runtime of runtimes) startRegion(runtime);
	/**
	* Notice sign-ins that happen while DSH keeps running.
	*
	* Without this the model group would only appear after a restart, because the
	* initial fetch happens once at startup.
	*
	* The catalog is re-fetched only when there is something new to fetch: while a
	* region has no account, polling the upstream would be a wasted request every
	* interval (and the upstream is the last place to spend gratuitous traffic).
	* A region that already has a catalog is left alone — model rosters change on
	* the order of days, and `refreshCatalog` re-fetches on the next sign-in
	* anyway. This keeps the interval cheap and the log quiet.
	*/
	const poll = setInterval(() => {
		if (stopped) return;
		for (const runtime of runtimes) runtime.store.current().then(async (credential) => {
			if (credential === void 0) {
				if (runtime.catalog.setVisible(false)) ctx.emit("llm/adapters-updated");
				return;
			}
			if (!runtime.catalog.isVisible()) {
				if (await refreshCatalog(ctx, runtime, log, "login")) ctx.emit("llm/adapters-updated");
			}
		}).catch((error) => {
			ctx.logger.warn("dsh-workbuddy-oauth: 账号轮询失败", error);
		});
	}, CREDENTIAL_POLL_MS);
	timers.push(poll);
	/**
	* Complete a sign-in: redeem the authorization, persist the credential, and
	* refresh every region's catalog.
	*
	* **One implementation, two surfaces.** Both `/wb-login` and the settings
	* card's sign-in button reach the upstream through this, so the two entry
	* points cannot drift into two different login flows — the failure that would
	* produce is a card that signs in "successfully" while the command path (which
	* the rest of the plugin trusts) never ran.
	*/
	const completeLogin = async (state) => {
		const credential = credentialFromLogin(await logins.complete(state));
		await saveAccount(credential);
		await forgetAccount(credential.uid);
		await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, "login")));
		ctx.emit("llm/adapters-updated");
		return {
			uid: credential.uid,
			label: displayNameOf(credential)
		};
	};
	/**
	* Remove an account and every trace of it, then refresh the catalogs.
	*
	* **One implementation, two surfaces.** Both `/wb-logout` and the settings
	* card's sign-out reach this, so neither can leave behind state the other
	* erases. The credential file is the secret and goes first (see
	* `account-purge.ts`); the uid-keyed stores follow.
	*
	* `enterpriseId` is needed to build the probe key but is not known to the
	* caller once the credential file is gone, so it is read here first.
	*/
	const removeAccountCompletely = async (uid) => {
		const accountKey = accountIdentityOf((await listCredentials()).find((credential) => credential.uid === uid));
		await purgeAccount(uid, {
			...accountKey === void 0 ? {} : { accountKey },
			forgetProbeRecords: (key) => runtimes.reduce((count, runtime) => count + (runtime.probeStore.forget(key) ? 1 : 0), 0)
		});
		await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, "login")));
		ctx.emit("llm/adapters-updated");
	};
	/**
	* Register the sign-in commands.
	*
	* `userQuestions` is read through `ctx.get` rather than declared as a
	* dependency: it is absent in headless and ACP profiles, and injecting it
	* would make the whole plugin refuse to load there. The command layer
	* degrades to a text prompt when it is missing.
	*/
	const commandDisposers = registerCommands(ctx, logins, {
		complete: completeLogin,
		remove: removeAccountCompletely,
		userQuestions: ctx.get("userQuestions"),
		warn: (message, error) => {
			ctx.logger.warn(`dsh-workbuddy-oauth: ${message}`, error);
		}
	});
	/**
	* Same-origin routes backing the settings card and the probe control.
	*
	* `webServer` is optional — a headless or ACP profile serves no browser — so
	* it is reached through `ctx.inject` rather than declared in `inject`. Naming
	* it as a hard dependency would make the whole plugin refuse to load exactly
	* where the commands still work.
	*/
	const controlKey = createControlKey();
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyStatusRoute(webCtx, {
			regions: runtimes.map((runtime) => ({
				region: runtime.region,
				providerId: providerIdFor(runtime.region),
				models: () => runtime.catalog.roster(),
				probeRunning: () => runtime.probeService.isRunning(),
				probeCandidates: () => runtime.catalog.current().filter((info) => runtime.probeService.isCandidate(info.id)).map((info) => info.id),
				probeResults: () => runtime.catalog.current().flatMap((info) => {
					const record = runtime.probeService.recordFor(info.id);
					return record === void 0 ? [] : [{
						id: info.id,
						record
					}];
				}),
				hiddenModels: () => runtime.catalog.hiddenModelIds(),
				useMaximumContextWindow: () => runtime.catalog.isUsingMaximumContextWindow()
			})),
			controlKey
		});
		for (const runtime of runtimes) registerWorkBuddyControlRoute(webCtx, {
			path: controlPathFor(runtime.region),
			probe: async (modelId) => {
				const result = await runtime.probeService.probe(modelId, true);
				if (result.state === "ok") runtime.invalidate();
				return result;
			},
			clear: () => {
				runtime.probeStore.clear();
				runtime.invalidate();
			},
			refresh: async () => {
				if (stopped) return {
					state: "failed",
					reason: "plugin is stopping"
				};
				if (await refreshCatalog(ctx, runtime, log, "login")) runtime.invalidate();
				return runtime.catalog.isVisible() ? {
					state: "refreshed",
					reason: `${runtime.catalog.current().length} models`
				} : { state: "signed-out" };
			},
			/**
			* The card's sign-in flow.
			*
			* `begin` is region-specific because the authorization URL is issued by
			* one upstream, but `complete` is not: the state carries its own region
			* (see `LoginClient`), so the card cannot redeem a state against the
			* wrong host. Both regions therefore share one `complete`.
			*/
			loginBegin: async (region) => {
				const target = region === "global" ? "global" : "cn";
				const request = await logins.begin(target);
				return {
					state: "pending",
					url: request.url,
					loginState: request.state
				};
			},
			loginComplete: async (state) => {
				try {
					return {
						state: "ok",
						reason: (await completeLogin(state)).label
					};
				} catch (error) {
					if (error instanceof LoginPendingError) return { state: "pending" };
					return {
						state: "failed",
						reason: error instanceof Error ? error.message : String(error)
					};
				}
			},
			/**
			* The card's counterpart to `/wb-logout`.
			*
			* Erases every trace of the account — the credential file, its persisted
			* cooldown, its enable/disable state, and its probe records — via the
			* same path the command uses, so the two surfaces cannot drift. The
			* upstream account is untouched. The catalog is refreshed so a group that
			* is now empty disappears instead of offering models that can only fail.
			*/
			logout: async (uid) => {
				const target = (await listCredentials()).find((credential) => credential.uid === uid);
				if (target === void 0) return {
					state: "failed",
					reason: "no such account"
				};
				const label = displayNameOf(target);
				await removeAccountCompletely(uid);
				return {
					state: "ok",
					reason: label
				};
			},
			/**
			* The card's counterpart to `/wb-account enable|disable`.
			*
			* Reversible, unlike {@link logout}: the credential file stays, so the
			* account keeps its tokens and only leaves selection. The catalog is
			* refreshed because disabling the account in use must drop the group
			* rather than leave it serving requests that will now fail.
			*/
			setAccountEnabled: async (uid, enabled) => {
				if (!(await listCredentials()).some((credential) => credential.uid === uid)) return {
					state: "failed",
					reason: "no such account"
				};
				await setAccountDisabled(uid, !enabled);
				await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, "login")));
				ctx.emit("llm/adapters-updated");
				return {
					state: "ok",
					reason: enabled ? "enabled" : "disabled"
				};
			},
			/**
			* The card's counterpart to hiding a model.
			*
			* The host owns both the catalog filter and the persisted rule, so the
			* picker and the checkbox cannot disagree. The loop's `runtime` is the
			* region this route serves; the body's region is checked rather than
			* trusted, since a route posting to the wrong region would hide the wrong
			* roster.
			*/
			setModelVisible: async (region, modelId, visible) => {
				if (region !== runtime.region) return {
					state: "failed",
					reason: `region mismatch: ${region}`
				};
				const next = new Set(runtime.catalog.hiddenModelIds());
				if (visible) next.delete(modelId);
				else next.add(modelId);
				const changed = runtime.catalog.setHiddenModels(next);
				await setRegionHiddenModels(runtime.region, [...next]);
				if (changed) runtime.invalidate();
				return {
					state: "ok",
					reason: visible ? "visible" : "hidden"
				};
			},
			/**
			* The card's counterpart to the maximum-context-window preference.
			*
			* One flag shared across regions; the host owns the catalog flag and the
			* persistence, so the picker and the checkbox cannot disagree. Invalidates
			* the adapter only when the flag actually changed.
			*/
			setMaximumContextWindow: async (enabled) => {
				await writeUseMaximumContextWindow(enabled);
				let changed = false;
				for (const region of runtimes) if (region.catalog.setUseMaximumContextWindow(enabled)) changed = true;
				if (changed) ctx.emit("llm/adapters-updated");
				return {
					state: "ok",
					reason: enabled ? "maximum" : "default"
				};
			},
			/**
			* The card's counterpart to P5.1: fetch one account's balance.
			*
			* Reads the stored credential by uid and asks the upstream for its
			* balance, returning it in `credits` for immediate display.
			*/
			refreshCredits: async (uid) => {
				const credential = (await listCredentials()).find((item) => item.uid === uid);
				if (credential === void 0) return {
					state: "failed",
					reason: "no such account"
				};
				try {
					return {
						state: "ok",
						reason: "credits",
						credits: await runtime.client.fetchCredits(credential)
					};
				} catch (error) {
					return {
						state: "failed",
						reason: error instanceof Error ? error.message : String(error)
					};
				}
			}
		}, controlKey);
	});
	ctx.effect(() => () => {
		stopped = true;
		for (const timer of timers) clearInterval(timer);
		for (const dispose of commandDisposers) dispose();
		for (const close of shims) close();
	});
	log(`已加载 v${PLUGIN_VERSION}（自有 OAuth 登录，不读取桌面端）`);
}
//#endregion
export { ALL_REGIONS, AUTOMATIC_PROBING_AUTHORIZED, COOLDOWN_STATE_FILENAME, Config, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, LoginClient, LoginExpiredError, LoginPendingError, NotSignedInError, PLUGIN_VERSION, PROBE_EFFORT_CANDIDATES, WORKBUDDY_AI_CONTROL_PATH, WORKBUDDY_AI_PROVIDER, WORKBUDDY_CONTROL_KEY_HEADER, WORKBUDDY_CONTROL_PATH, WORKBUDDY_PROVIDER, WORKBUDDY_STATUS_PATH, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WorkBuddyCatalog, WorkBuddyProbeService, WorkBuddyProbeStore, accountIdentityOf, apply, chooseRotating, controlPathFor, createControlKey, createCredentialStore, createWorkBuddyAdapter, createWorkBuddyShim, credentialFromLogin, deriveId, deviceHeaders, displayNameOf, fingerprintModel, inject, listCredentials, maskPhoneNumbers, name, parseRegionInput, probeModel, providerIdFor, readCooldowns, regionEndpoints, regionOfDomain, requestId, workBuddyControlHandler, workBuddyStatusHandler, workBuddyWebStatus, workbuddyProbePath, writeCooldown };

window.__ModuleLoader__.load({
	id: "dsh-workbuddy-oauth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/** Read-only status endpoint consumed by this plugin's browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-oauth/status";
		/** Header carrying the in-process control key on a control request. */
		const WORKBUDDY_CONTROL_KEY_HEADER = "x-workbuddy-oauth-key";
		//#endregion
		//#region src/client/host.ts
		/**
		* Shared browser-side helpers: reading the host status document and the control
		* route.
		*
		* Both the settings card and the reasoning-level control read the same route, so
		* the shape check and the POST helper live here rather than being duplicated —
		* a second copy is how the two halves start disagreeing about what a valid
		* document is.
		*
		* @module dsh-workbuddy-oauth/client/host
		*/
		/**
		* Whether a parsed response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Storing an unchecked value would put
		* something in React state that the next render dereferences.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			if (wrapped["status"] !== "ok") return false;
			if (typeof wrapped["controlKey"] !== "string") return false;
			return Array.isArray(wrapped["regions"]) && Array.isArray(wrapped["accounts"]);
		}
		/** Read the status document, or `undefined` when it is unavailable or malformed. */
		async function readStatus(signal) {
			try {
				const response = await fetch(WORKBUDDY_STATUS_PATH, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) return void 0;
				const value = await response.json().catch(() => void 0);
				return isWorkBuddyWebStatus(value) ? value : void 0;
			} catch {
				return;
			}
		}
		/**
		* POST one control action.
		*
		* Resolves to the parsed result, or `undefined` when the request failed — the
		* callers all report failure in their own surface rather than throwing into a
		* React event handler, where nothing would catch it.
		*/
		async function sendControl(path, key, body) {
			try {
				const response = await fetch(path, {
					method: "POST",
					credentials: "same-origin",
					headers: {
						"Content-Type": "application/json",
						[WORKBUDDY_CONTROL_KEY_HEADER]: key
					},
					body: JSON.stringify(body)
				});
				if (!response.ok) return void 0;
				const value = await response.json().catch(() => void 0);
				if (typeof value !== "object" || value === null) return void 0;
				const wrapped = value;
				if (typeof wrapped["state"] !== "string") return void 0;
				return {
					state: wrapped["state"],
					...typeof wrapped["reason"] === "string" ? { reason: wrapped["reason"] } : {},
					...typeof wrapped["url"] === "string" ? { url: wrapped["url"] } : {},
					...typeof wrapped["loginState"] === "string" ? { loginState: wrapped["loginState"] } : {},
					...isCreditsShape(wrapped["credits"]) ? { credits: wrapped["credits"] } : {}
				};
			} catch {
				return;
			}
		}
		/** Whether a value is a usable credit answer (total plus its package list). */
		function isCreditsShape(value) {
			if (typeof value !== "object" || value === null) return false;
			const candidate = value;
			if (typeof candidate["total"] !== "number" || !Number.isFinite(candidate["total"])) return false;
			return Array.isArray(candidate["accounts"]);
		}
		/** Find the region a provider id belongs to, or `undefined` for another plugin's model. */
		function regionOfProvider(status, provider) {
			return status.regions.find((region) => region.providerId === provider);
		}
		//#endregion
		//#region src/client/credit-slot.ts
		/**
		* Decide the slot for one account.
		*
		* Order matters. A failure is reported ahead of a stale balance, because a
		* figure the card can no longer stand behind is worse than admitting the check
		* failed. `unlimited` is reported ahead of `total`, and never falls back to it:
		* the two mean opposite things ("no cap" vs "nothing left"), so an uncapped
		* account would otherwise render as a confident zero.
		*
		* @param busy - whether a check is in flight for this account.
		* @param error - the last failure's reason, if any.
		* @param credits - the last successful answer, if any.
		*/
		function creditSlot(busy, error, credits) {
			if (credits !== void 0 && error === void 0) return credits.unlimited === true ? { kind: "unlimited" } : {
				kind: "balance",
				total: credits.total
			};
			if (busy) return { kind: "loading" };
			if (error !== void 0) return { kind: "retry" };
			return { kind: "query" };
		}
		//#endregion
		//#region src/client/WorkBuddyConfigPage.tsx
		/**
		* The bundle's configuration page on the Plugins page.
		*
		* Shows the accounts this plugin holds and triggers the same OAuth sign-in the
		* `/wb-login` command drives. The card is a *transport* over the control route,
		* never a second login implementation — a card that authenticated on its own
		* would let the UI report success while the path the rest of the plugin trusts
		* (the credential file and the catalog refresh) never ran.
		*
		* ## Why class names rather than inline styles
		*
		* An inline `style` prop cannot express `:hover`, `:active`, `:focus-visible` or
		* `:disabled`, so a card built entirely from inline styles has no interaction
		* feedback and its disabled buttons look live. All styling therefore lives in
		* `./styles.ts`, installed once per document.
		*
		* ## Why the status document drives every mutation
		*
		* The card never predicts an outcome locally. A toggle the host refused must not
		* look applied, so every action posts and then re-reads the truth.
		*
		* @module dsh-workbuddy-oauth/client/WorkBuddyConfigPage
		*/
		/** Button classes; interaction states come from the stylesheet. */
		const BTN = "wb-btn";
		const BTN_PRIMARY = "wb-btn wb-btn-primary";
		const BTN_DANGER = "wb-btn wb-btn-danger";
		/** How often the card re-checks the status document. */
		const RECONCILE_MS$1 = 3e4;
		/** Render the bundle's configuration. */
		function WorkBuddyConfigPage({ view, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [pending, setPending] = (0, react.useState)();
			const [notice, setNotice] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [busyKey, setBusyKey] = (0, react.useState)();
			const [tab, setTab] = (0, react.useState)("accounts");
			const [credits, setCredits] = (0, react.useState)({});
			const [creditsError, setCreditsError] = (0, react.useState)({});
			const [creditsBusy, setCreditsBusy] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [confirmingUid, setConfirmingUid] = (0, react.useState)();
			/**
			* Collapsed mode for both card grids: one row per card, name and actions only.
			*
			* Defaults to expanded. Shared by the accounts and credits tabs so switching
			* between them does not silently change how much is on screen.
			*/
			const [collapsed, setCollapsed] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(false);
			/**
			* Guards the completion call so two overlapping redeems cannot race: redeeming
			* the same state twice would race, and the loser can only report a failure for
			* a sign-in that actually succeeded.
			*/
			const completing = (0, react.useRef)(false);
			const refresh = (0, react.useCallback)(async (signal) => {
				const value = await readStatus(signal);
				if (!mounted.current) return;
				if (value !== void 0) setStatus(value);
				setLoaded(true);
			}, []);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, RECONCILE_MS$1);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
				};
			}, [refresh]);
			/**
			* Redeem an outstanding authorization.
			*
			* The upstream does not report the browser approval to us; the host finds out
			* by redeeming the state, so this is a question, and `pending` is a normal
			* in-between answer rather than an error.
			*/
			const completeLogin = (0, react.useCallback)(async (state) => {
				if (status === void 0 || completing.current) return;
				completing.current = true;
				setBusyKey("refresh");
				try {
					const result = await sendControl(status.regions[0]?.controlPath ?? "", status.controlKey, {
						action: "login-complete",
						state
					});
					if (!mounted.current) return;
					if (result === void 0) {
						setNotice({
							text: t("loginFailed", { reason: t("working") }),
							kind: "err"
						});
						return;
					}
					if (result.state === "ok") {
						setPending(void 0);
						setNotice({
							text: t("loginSucceeded", { label: result.reason ?? "" }),
							kind: "ok"
						});
						await refresh();
						return;
					}
					if (result.state === "failed") {
						setPending(void 0);
						setNotice({
							text: t("loginFailed", { reason: result.reason ?? "" }),
							kind: "err"
						});
					}
				} finally {
					completing.current = false;
					if (mounted.current) setBusyKey(void 0);
				}
			}, [
				status,
				t,
				refresh
			]);
			const startLogin = async (region) => {
				if (status === void 0 || busy) return;
				setBusy(true);
				setBusyKey(`login-${region}`);
				setNotice(void 0);
				try {
					const result = await sendControl(status.regions[0]?.controlPath ?? "", status.controlKey, {
						action: "login-begin",
						region
					});
					if (result?.state === "pending" && result.url !== void 0 && result.loginState !== void 0) setPending({
						state: result.loginState,
						url: result.url,
						region
					});
					else setNotice({
						text: t("loginFailed", { reason: result?.reason ?? t("loginStarting") }),
						kind: "err"
					});
				} finally {
					if (mounted.current) {
						setBusy(false);
						setBusyKey(void 0);
					}
				}
			};
			/** The card's Refresh: complete any outstanding login, then re-read. */
			const onRefresh = async () => {
				if (pending !== void 0) {
					await completeLogin(pending.state);
					return;
				}
				setBusyKey("refresh");
				await refresh();
				if (mounted.current) setBusyKey(void 0);
			};
			/**
			* Run one per-account control action and re-read the document.
			*
			* Each action reports its own name on failure: reusing the sign-in wording
			* made a failed "disable" read as "sign-in failed", which points the user at
			* the wrong thing entirely.
			*/
			const runAccountAction = async (body, label) => {
				if (status === void 0 || busy) return;
				const doing = body.action === "logout" ? t("logoutFailed") : t("toggleAccountFailed");
				setBusy(true);
				setBusyKey(`${body.action}-${body.uid}`);
				setNotice(void 0);
				try {
					const result = await sendControl(status.regions[0]?.controlPath ?? "", status.controlKey, body);
					if (result === void 0 || result.state !== "ok") {
						setNotice({
							text: t("actionFailed", {
								action: doing,
								reason: result?.reason ?? t("working")
							}),
							kind: "err"
						});
						return;
					}
					setNotice({
						text: body.action === "logout" ? t("logoutSucceeded", { label }) : t(body.enabled ? "enableSucceeded" : "disableSucceeded", { label }),
						kind: "ok"
					});
					setConfirmingUid(void 0);
					await refresh();
				} finally {
					if (mounted.current) {
						setBusy(false);
						setBusyKey(void 0);
					}
				}
			};
			/**
			* Fetch one account's credit balance and hold it for display.
			*
			* The balance is shown from local state rather than the status document: a
			* status read must not make a network call per account, so the balance is only
			* fetched when the user asks. A failed fetch clears any stale value, so the
			* card never keeps showing a balance it can no longer stand behind.
			*/
			const queryCredits = async (uid) => {
				if (status === void 0 || creditsBusy.has(uid)) return;
				setCreditsBusy((previous) => new Set(previous).add(uid));
				setCreditsError((previous) => {
					const next = { ...previous };
					delete next[uid];
					return next;
				});
				setBusyKey(`credits-${uid}`);
				try {
					const result = await sendControl(status.regions[0]?.controlPath ?? "", status.controlKey, {
						action: "refresh-credits",
						uid
					});
					if (!mounted.current) return;
					if (result === void 0 || result.state !== "ok" || result.credits === void 0) {
						setCredits((previous) => {
							const next = { ...previous };
							delete next[uid];
							return next;
						});
						setCreditsError((previous) => ({
							...previous,
							[uid]: result?.reason ?? t("working")
						}));
						return;
					}
					setCredits((previous) => ({
						...previous,
						[uid]: result.credits
					}));
				} finally {
					if (mounted.current) {
						setCreditsBusy((previous) => {
							const next = new Set(previous);
							next.delete(uid);
							return next;
						});
						setBusyKey(void 0);
					}
				}
			};
			/** Query every account's balance at once, for the credits tab. */
			const queryAllCredits = async () => {
				if (status === void 0) return;
				await Promise.all(status.accounts.map((account) => queryCredits(account.uid)));
			};
			/**
			* Hide or show one model.
			*
			* Posts to the region's own control path — the two regions share model ids, so
			* a model toggle must land on the roster it was listed under.
			*/
			const toggleModel = async (region, modelId, visible) => {
				if (status === void 0) return;
				setBusyKey(`model-${modelId}`);
				try {
					const result = await sendControl(region.controlPath, status.controlKey, {
						action: "set-model-visible",
						region: region.region,
						modelId,
						visible
					});
					await refresh();
					if (mounted.current && (result === void 0 || result.state !== "ok")) setNotice({
						text: t("actionFailed", {
							action: t("hideModelFailed"),
							reason: result?.reason ?? t("working")
						}),
						kind: "err"
					});
				} finally {
					if (mounted.current) setBusyKey(void 0);
				}
			};
			/** Select or clear the maximum-context-window preference. */
			const toggleMaxWindow = async (enabled) => {
				if (status === void 0) return;
				setBusyKey("maxwindow");
				try {
					const result = await sendControl(status.regions[0]?.controlPath ?? "", status.controlKey, {
						action: "set-maximum-context-window",
						enabled
					});
					await refresh();
					if (mounted.current && (result === void 0 || result.state !== "ok")) setNotice({
						text: t("actionFailed", {
							action: t("maxWindowFailed"),
							reason: result?.reason ?? t("working")
						}),
						kind: "err"
					});
				} finally {
					if (mounted.current) setBusyKey(void 0);
				}
			};
			if (view === "summary") return t("intro");
			const maxWindow = status?.regions[0]?.useMaximumContextWindow === true;
			/**
			* How many models the maximum-window toggle actually changes, counted from the
			* roster rather than assumed: a region whose models all declare one window is
			* unaffected, and the hint must not promise a change that cannot happen.
			*/
			const windowAffected = status === void 0 ? 0 : status.regions.reduce((sum, region) => sum + region.models.filter((model) => model.multiWindow === true).length, 0);
			const tabButton = (id, label) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "tab",
				className: "wb-tab",
				"aria-selected": tab === id,
				onClick: () => {
					setTab(id);
				},
				children: label
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-titlerow",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-title",
							children: t("title")
						}), status === void 0 || status.accounts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-count",
							children: t("accountCount", { count: status.accounts.length })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wb-intro",
						children: t("intro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: BTN,
								disabled: busy || status === void 0,
								"data-busy": busyKey === "login-cn" ? "1" : void 0,
								onClick: () => {
									startLogin("cn");
								},
								children: [
									t("login"),
									" · ",
									t("regionCn")
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: BTN,
								disabled: busy || status === void 0,
								"data-busy": busyKey === "login-global" ? "1" : void 0,
								onClick: () => {
									startLogin("global");
								},
								children: [
									t("login"),
									" · ",
									t("regionGlobal")
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								disabled: status === void 0,
								"data-busy": busyKey === "refresh" ? "1" : void 0,
								onClick: () => {
									onRefresh();
								},
								children: t("refresh")
							}),
							status === void 0 || status.accounts.length === 0 || tab !== "accounts" && tab !== "credits" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wb-spacer" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								"aria-pressed": collapsed,
								onClick: () => {
									setCollapsed(!collapsed);
								},
								children: collapsed ? t("expand") : t("collapse")
							})] })
						]
					}),
					pending === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-note wb-note-busy wb-panel",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("loginOpenLink") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: pending.url,
								target: "_blank",
								rel: "noreferrer",
								className: "wb-link",
								children: pending.url
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "wb-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN_PRIMARY,
										disabled: busyKey === "refresh",
										"data-busy": busyKey === "refresh" ? "1" : void 0,
										onClick: () => {
											completeLogin(pending.state);
										},
										children: t("loginConfirmAction")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN,
										onClick: () => {
											setPending(void 0);
											setNotice({
												text: t("loginCancelled"),
												kind: "warn"
											});
										},
										children: t("cancel")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wb-hint",
										children: t("loginRefreshHint")
									})
								]
							})
						]
					}),
					notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						className: `wb-note wb-note-${notice.kind} wb-row`,
						children: [
							notice.text,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								onClick: () => {
									setNotice(void 0);
								},
								children: t("dismiss")
							})
						]
					}),
					status === void 0 ? loaded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "wb-note wb-note-err wb-row",
						children: [
							t("statusUnavailable"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								onClick: () => {
									setLoaded(false);
									refresh();
								},
								children: t("retry")
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wb-hint",
						children: t("statusUnavailableHint")
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wb-note wb-note-busy wb-row",
						children: t("statusLoading")
					}) : null,
					status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							role: "tablist",
							className: "wb-tabbar",
							children: [
								tabButton("accounts", t("tabAccounts")),
								tabButton("models", t("tabModels")),
								tabButton("credits", t("tabCredits"))
							]
						}),
						tab === "accounts" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wb-panel",
							children: status.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-note",
								children: t("creditsNone")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountCards, {
								accounts: status.accounts,
								t,
								busy,
								busyKey,
								confirmingUid,
								collapsed,
								onAskLogout: setConfirmingUid,
								onCancelLogout: () => {
									setConfirmingUid(void 0);
								},
								onToggle: (uid, enabled) => runAccountAction({
									action: "set-account-enabled",
									uid,
									enabled
								}, labelOf(status, uid)),
								onLogout: (uid) => runAccountAction({
									action: "logout",
									uid
								}, labelOf(status, uid))
							})
						}) : null,
						tab === "models" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wb-panel",
							children: status.regions.map((region) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RegionBlock, {
								region,
								t,
								busy,
								busyKey,
								maxWindow,
								windowAffected,
								onToggleMaxWindow: toggleMaxWindow,
								onToggleModel: (modelId, visible) => toggleModel(region, modelId, visible),
								onLogin: () => {
									startLogin(region.region);
								}
							}, region.region))
						}) : null,
						tab === "credits" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wb-panel",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "wb-row",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wb-label",
											children: t("creditsHeading")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wb-muted",
											children: t("accountCount", { count: status.accounts.length })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wb-spacer" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: BTN,
											disabled: status.accounts.length === 0 || creditsBusy.size > 0,
											onClick: () => {
												queryAllCredits();
											},
											children: t("creditsRefreshAll")
										})
									]
								}),
								status.accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-note",
									children: t("creditsNone")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-hint",
									children: t("creditsIntro")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: collapsed ? "wb-acct-cards wb-acct-cards-collapsed" : "wb-acct-cards",
									children: status.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditCard, {
										account,
										t,
										credits: credits[account.uid],
										error: creditsError[account.uid],
										busy: creditsBusy.has(account.uid),
										onQuery: () => {
											queryCredits(account.uid);
										}
									}, account.uid))
								})
							]
						}) : null
					] })
				]
			});
		}
		/** One account's label, for an action's success message. */
		function labelOf(status, uid) {
			return status.accounts.find((account) => account.uid === uid)?.label ?? uid.slice(0, 8);
		}
		/**
		* The account list, as a grid of cards.
		*
		* Cards rather than a table. A table needs a header row to say what each column
		* is, and that header plus its separator sat directly under the tab strip's own
		* border — two rules stacked, which read as clutter. A card carries its own
		* context instead: the uid, state and token lifetime sit under the name they
		* describe, so no header is needed at all.
		*
		* The grid is `auto-fill` with a minimum width (in the stylesheet), so a narrow
		* settings panel drops to one column rather than squeezing two.
		*/
		function AccountCards({ accounts, t, busy, busyKey, confirmingUid, collapsed, onAskLogout, onCancelLogout, onToggle, onLogout }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: collapsed ? "wb-acct-cards wb-acct-cards-collapsed" : "wb-acct-cards",
				children: accounts.map((account) => {
					const confirming = confirmingUid === account.uid;
					const expiry = expiryOf(account, t);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wb-acct-card",
						children: confirming ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wb-confirm",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-label",
									children: t("logoutConfirmTitle", { label: account.label })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-muted",
									children: t("logoutConfirmBody")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wb-confirm-actions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN,
										onClick: onCancelLogout,
										children: t("cancel")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN_DANGER,
										disabled: busy,
										"data-busy": busyKey === `logout-${account.uid}` ? "1" : void 0,
										onClick: () => {
											onLogout(account.uid);
										},
										children: t("logoutConfirmAction")
									})]
								})
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wb-acct-main",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wb-acct-top",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-acct-name",
									title: account.label,
									children: account.label
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-badge",
									children: account.region === "cn" ? t("regionCn") : t("regionGlobal")
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wb-acct-meta",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wb-acct-uid",
										children: account.uid.slice(0, 8)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wb-acct-sep",
										children: "·"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: account.enabled ? void 0 : "wb-tag-off",
										children: account.enabled ? t("enabledTag") : t("disabledTag")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wb-acct-sep",
										children: "·"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `wb-acct-exp ${expiry.warn ? "wb-tag-warn" : ""}`,
										children: expiry.text
									})
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wb-acct-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								disabled: busy,
								"data-busy": busyKey === `set-account-enabled-${account.uid}` ? "1" : void 0,
								onClick: () => {
									onToggle(account.uid, !account.enabled);
								},
								children: account.enabled ? t("disable") : t("enable")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN,
								disabled: busy,
								onClick: () => {
									onAskLogout(account.uid);
								},
								children: t("logout")
							})]
						})] })
					}, account.uid);
				})
			});
		}
		/**
		* How long this account's access token lasts, as text.
		*
		* The status document has always carried `expiresAtMs` and the card never showed
		* it, so a token about to lapse was invisible until the next request failed.
		* Days only past 48 hours, so a nine-hour token is not reported as "0 days".
		*/
		function expiryOf(account, t) {
			const left = account.expiresAtMs - Date.now();
			if (left <= 0) return {
				text: t("tokenExpired"),
				warn: true
			};
			const minutes = Math.floor(left / 6e4);
			if (minutes < 60) return {
				text: t("tokenRefreshesInMinutes", { minutes }),
				warn: minutes < 5
			};
			const hours = Math.floor(minutes / 60);
			if (hours < 48) return {
				text: t("tokenRefreshesIn", { hours }),
				warn: false
			};
			return {
				text: t("tokenRefreshesInDays", { days: Math.floor(hours / 24) }),
				warn: false
			};
		}
		/**
		* One region's block: its models, and the maximum-window switch where it applies.
		*
		* No collapse behaviour. Collapsing exists to make a long *list of accounts*
		* scannable; a model roster is exactly the content this tab is opened for, so
		* hiding parts of it would leave the tab with nothing to do.
		*/
		function RegionBlock({ region, t, busy, busyKey, maxWindow, windowAffected, onToggleMaxWindow, onToggleModel, onLogin }) {
			const hidden = new Set(region.hiddenModels);
			const affects = region.models.filter((model) => model.multiWindow === true).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wb-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-region-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-region-title",
							children: region.label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: region.signedIn ? "wb-ok" : "wb-muted",
							children: region.signedIn ? t("signedInWithModels", { count: region.models.length }) : t("signedOut")
						})]
					}),
					region.signedIn ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-note",
							children: t("noAccountsInRegion")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: BTN,
							disabled: busy,
							onClick: onLogin,
							children: [
								t("login"),
								" · ",
								region.region === "cn" ? t("regionCn") : t("regionGlobal")
							]
						})]
					}),
					!region.signedIn || affects === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "wb-maxrow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: maxWindow,
								disabled: busyKey === "maxwindow",
								onChange: () => {
									onToggleMaxWindow(!maxWindow);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-label",
								children: t("useMaximumContextWindow")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-hint",
								children: maxWindow ? t("maxWindowHintOn", { count: windowAffected }) : t("maxWindowHintOff", { count: windowAffected })
							})
						]
					}),
					region.signedIn && region.models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wb-grid",
						children: region.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "wb-mrow",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: !hidden.has(model.id),
									onChange: () => onToggleModel(model.id, hidden.has(model.id))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wb-mname",
									style: hidden.has(model.id) ? { opacity: .45 } : void 0,
									children: model.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: maxWindow && model.multiWindow === true ? "wb-ctx wb-ctx-up" : "wb-ctx",
									children: formatContext(model.contextWindow)
								})
							]
						}, model.id))
					}) }) : null
				]
			});
		}
		/**
		* One account's credit balance, in the same card shape as the accounts tab.
		*
		* The right slot carries whatever this card's state calls for — a button before
		* the first check, then the number itself, which is also the button that checks
		* again. One slot, one element: an earlier layout showed a value and a "check
		* again" button side by side, which said the same thing twice.
		*
		* **Collapsing does not change the slot.** A previous version swapped the number
		* for a plain button when collapsed, which left the fetched balance with nowhere
		* to appear: pressing the button looked like it had done nothing at all. What
		* collapse hides is the second, descriptive line, never the result.
		*/
		function CreditCard({ account, t, credits, error, busy, onQuery }) {
			const expiry = expiryOf(account, t);
			const slot = creditSlot(busy, error, credits);
			let body;
			if (slot.kind === "loading") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: BTN,
				disabled: true,
				"data-busy": "1",
				children: t("creditsLoading")
			});
			else if (slot.kind === "retry") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: BTN,
				onClick: onQuery,
				children: t("retry")
			});
			else if (slot.kind === "query") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: BTN,
				onClick: onQuery,
				children: t("queryCredits")
			});
			else if (slot.kind === "unlimited") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "wb-credit-value",
				title: t("requeryCredits"),
				onClick: onQuery,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wb-credit-unlimited",
					children: t("creditsUnlimited")
				})
			});
			else body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "wb-credit-value",
				title: t("requeryCredits"),
				onClick: onQuery,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wb-credit-num",
					children: slot.total
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wb-credit-unit",
					children: t("creditsUnit")
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: error === void 0 ? "wb-credit-card" : "wb-credit-card wb-credit-card-err",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wb-credit-main",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-credit-top",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-credit-name",
							title: account.label,
							children: account.label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wb-badge",
							children: account.region === "cn" ? t("regionCn") : t("regionGlobal")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wb-credit-meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-acct-uid",
								children: account.uid.slice(0, 8)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-acct-sep",
								children: "·"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: account.enabled ? void 0 : "wb-tag-off",
								children: account.enabled ? t("enabledTag") : t("disabledTag")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-acct-sep",
								children: "·"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `wb-acct-exp ${expiry.warn ? "wb-tag-warn" : ""}`,
								children: expiry.text
							}),
							error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-acct-sep",
								children: "·"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wb-tag-off",
								children: t("creditsError", { reason: error })
							})] })
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "wb-credit-slot",
					children: body
				})]
			});
		}
		/** Render a token count compactly: 1,000,000 → `1M`, 192,000 → `192K`. */
		function formatContext(tokens) {
			if (tokens >= 1e6) return `${Number((tokens / 1e6).toFixed(1))}M`;
			return `${Math.round(tokens / 1e3)}K`;
		}
		//#endregion
		//#region src/client/WorkBuddyProbeControl.tsx
		/**
		* Per-model reasoning-level detection beside the composer's model selector.
		*
		* The reasoning-level gap this control closes: the upstream no longer declares
		* `supportedEfforts` for most models, so the picker shows no level chooser for
		* them. A user-authorized probe records which spellings the upstream accepts,
		* and once recorded the adapter exposes those levels in the dropdown. This
		* control is the *trigger* — the levels themselves appear in the model picker,
		* never here.
		*
		* One icon, annotated with a static label and a tooltip. It shows only when the
		* selected model belongs to this plugin and is an undeclared, reasoning-capable
		* row — every other selection renders nothing, which is what keeps the icon off
		* non-WorkBuddy models.
		*
		* @module dsh-workbuddy-oauth/client/WorkBuddyProbeControl
		*/
		/** How often the control re-checks state while the window is focused. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		const primaryButtonStyle = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/** Whether a model id is in the region's probe-candidate list. */
		function isCandidate(region, model) {
			return region.probeCandidates.includes(model);
		}
		/** The recorded observation for a model, or `undefined`. */
		function resultFor(region, model) {
			return region.probeResults.find((result) => result.id === model);
		}
		/**
		* The model-selection snapshot read through `useSyncExternalStore`. The
		* directory's store is the same uSES-shaped object connect reads, so this
		* control can stay model-agnostic about where the selection comes from.
		*/
		function useSelection(directory) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			return (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
		}
		/**
		* The per-model control. Mounted with a `key` so a selection change remounts it
		* and clears any open bubble.
		*/
		function WorkBuddyProbeControl({ directory, t }) {
			const selection = useSelection(directory);
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const [failed, setFailed] = (0, react.useState)(false);
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const value = await readStatus(signal);
				if (mounted.current && !signal?.aborted && seq === readSeq.current && value !== void 0) setStatus(value);
			}, []);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, RECONCILE_MS);
				window.addEventListener("focus", () => {
					refresh(controller.signal);
				});
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", () => {
						refresh(controller.signal);
					});
				};
			}, [refresh]);
			if (selection === null || status === void 0) return null;
			const region = regionOfProvider(status, selection.provider);
			if (region === void 0) return null;
			const model = selection.model;
			const result = resultFor(region, model);
			if (!(isCandidate(region, model) || result !== void 0)) return null;
			const detect = async () => {
				if (inFlight.current || region.probeRunning) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const outcome = await sendControl(region.controlPath, status.controlKey, {
						action: "probe",
						model
					});
					if (outcome === void 0 || outcome.state !== "ok") {
						if (mounted.current) setFailed(true);
						return;
					}
					await refresh();
					const fresh = resultFor(region, model);
					if (fresh !== void 0 && mounted.current) setNote(fresh);
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			const text = busy ? t("probeTooltipRunning", { model }) : result !== void 0 && result.validation === "validating" && result.efforts.length > 0 ? t("probeTooltipVerified", { levels: result.efforts.join(" / ") }) : failed ? t("probeTooltipRetry") : t("probeTooltipIdle", { model });
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled: busy || region.probeRunning,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle,
							opacity: (busy || region.probeRunning) && !confirming ? .6 : 1
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: t("probeLabel")
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeConfirmBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: note.validation === "validating" && note.efforts.length > 0 ? t("probeNoteVerified", { levels: note.efforts.join(" / ") }) : t("probeNoteFailed") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: confirmButtonStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeDismiss")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* The settings card's stylesheet, injected at runtime.
		*
		* ## Why CSS lives in a TypeScript string
		*
		* The client half ships as ONE `lib/client.js`, registered through
		* `__ModuleLoader__.load`. A `.css` file beside it would never load: nothing
		* fetches it. And a CSS *import* is silently dropped by this build — measured,
		* `tsdown` emitted neither a sidecar nor an inline copy and the bundle's byte
		* size did not change, which is the worst possible failure because it looks
		* like success. So the rules are a string that the bundle carries and installs
		* itself.
		*
		* This is also what `dshmarket` does (its `client.js` carries the same
		* `style[data-plugin-css]` guard), so the pattern is established rather than
		* invented here.
		*
		* ## Why not inline `style` props, which is what this card used before
		*
		* A React `style` prop sets inline styles, and **inline styles cannot express
		* `:hover`, `:active`, `:focus-visible` or `:disabled`**. The card therefore had
		* no interaction feedback at all — and its ten `disabled={...}` buttons were
		* visually identical to live ones, so a click during a sign-in did nothing with
		* no explanation. Those four states need a real stylesheet.
		*
		* ## Token discipline
		*
		* Every colour is a `--dsw-alias-*` theme token, and the button rules mirror the
		* host's own `dsh-client-ui-primitives/lib/Button.module.css` so this card
		* reacts exactly like a host button. No literal colours except the white text on
		* the danger fill, which has no token because the host has no danger button.
		* A renamed token degrades appearance but cannot break rendering.
		*
		* @module dsh-workbuddy-oauth/client/styles
		*/
		/** Marks the injected tag, and keeps a second injection from duplicating it. */
		const STYLE_TAG_ID = "dsh-workbuddy-oauth/client";
		/**
		* Card stylesheet.
		*
		* Class names are prefixed `wb-` so nothing here can collide with a host class
		* or another plugin's — the host's own sheets are not scoped against us.
		*/
		const CSS = `
/* ============================================================
   Buttons — mirrors the host's Button.module.css
   ============================================================ */
.wb-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.wb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.wb-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.wb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.wb-btn:disabled { cursor: not-allowed; opacity: 0.4; }

/* Filled variant: reserved for an irreversible action worth emphasising. */
.wb-btn-primary {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.wb-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
  border-color: var(--dsw-alias-button-primary-hover);
}
.wb-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }

/* Destructive fill for the final sign-out confirmation. */
.wb-btn-danger {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
}
.wb-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, #fff);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, #fff);
}

/* ============================================================
   Tabs
   ============================================================ */
.wb-tabbar { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.wb-tab {
  padding: 4px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.wb-tab:hover:not([aria-selected='true']) { background: var(--dsw-alias-interactive-bg-hover); }
.wb-tab:active:not([aria-selected='true']) { background: var(--dsw-alias-interactive-bg-active); }
.wb-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.wb-tab[aria-selected='true'] {
  border-bottom-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

/* ============================================================
   Layout
   ============================================================ */
.wb-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.wb-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
/* Title row: the signed-in count sits beside the name, on the same baseline. */
.wb-titlerow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
/*
 * 12px against the title's 13px, and normal weight against its 600: the count
 * must not read as part of the heading. It is deliberately smaller than the
 * title rather than merely a different colour, so the hierarchy survives even
 * where a theme renders the success colour close to the label colour.
 */
.wb-count { font-size: 12px; font-weight: 400; color: var(--dsw-alias-state-success-primary); }
.wb-intro { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wb-panel { display: flex; flex-direction: column; gap: 8px; }
.wb-spacer { flex: 1; }
.wb-muted { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.wb-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
.wb-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.wb-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.wb-link { color: var(--dsw-alias-brand-primary); font-size: 12px; }

.wb-region-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}
.wb-region-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }

/* ============================================================
   Notices — colour carries the outcome
   ============================================================ */
.wb-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  word-break: break-all;
}
/* Tinted border and text, so success, failure and in-progress read differently
   at a glance instead of all looking like the same grey box. */
.wb-note-ok {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-success-primary);
}
.wb-note-err {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-error-primary);
}
.wb-note-warn {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-warn-primary);
}
.wb-note-busy {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2));
}

/* ============================================================
   Accounts and credits — the same card grid
   ============================================================ */
/*
 * One column, then two, and never more. auto-fill keeps adding columns as the
 * panel widens, which stretches each card into a wide, mostly empty strip; a
 * breakpoint pins the ceiling at two.
 */
.wb-acct-cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
/* 260px is where a card's contents stop being cramped; two columns plus the gap
   is about 530px, so the breakpoint sits at 560px. */
@media (min-width: 560px) {
  .wb-acct-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/*
 * Collapsed mode: one row per card, name and actions only.
 *
 * Only the second line is hidden, so the name, its region badge and the buttons
 * all survive — the badge sits on the first line, which is why a collapsed card
 * can still say which region it belongs to. Both card grids are covered: the
 * credits card is its own element, so it needs naming separately.
 */
.wb-acct-cards-collapsed .wb-acct-card,
.wb-acct-cards-collapsed .wb-credit-card { padding: 6px 10px; }
.wb-acct-cards-collapsed .wb-acct-main { gap: 0; }
.wb-acct-cards-collapsed .wb-acct-meta,
.wb-acct-cards-collapsed .wb-credit-meta { display: none; }
/*
 * Left/right split. The identity column takes the slack and truncates; the
 * actions column never shrinks, so a long nickname cannot push a button out of
 * the card.
 */
.wb-acct-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}
.wb-acct-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.wb-acct-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-acct-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The metadata line never wraps: it truncates its longest part instead, so the
   row height stays uniform across the grid. */
.wb-acct-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.wb-acct-uid { font-family: ui-monospace, Menlo, monospace; flex: 0 0 auto; }
.wb-acct-sep { opacity: 0.5; flex: 0 0 auto; }
/* The token text is the longest field and the one that gives way first; the uid
   and the state stay whole. */
.wb-acct-exp { overflow: hidden; text-overflow: ellipsis; }
.wb-acct-actions { display: flex; gap: 6px; flex: 0 0 auto; }

/* Region badge. */
.wb-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
/* A disabled account and a soon-to-expire token both need to stand out; as plain
   muted text they were indistinguishable from a healthy row. */
.wb-tag-off { font-size: 11px; color: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; }
.wb-tag-warn { color: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; }

/* Destructive confirmation, filling the card it replaces the actions in. */
.wb-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
}
.wb-confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* ============================================================
   Model grid
   ============================================================ */
.wb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 2px 16px;
  align-items: center;
}
.wb-mrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-mname {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-ctx {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* A window the maximum-context toggle actually changes, so the effect is visible. */
.wb-ctx-up { color: var(--dsw-alias-state-success-primary); font-weight: 600; }

.wb-maxrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

/* ============================================================
   Credits — the account card's shape, with the balance on the right
   ============================================================ */
/* Left/right split, matching the account card so the two tabs read as one UI. */
.wb-credit-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}
/* A failed check tints the border rather than inserting a row: an inline error
   would make one card taller than its neighbours and break the grid's rhythm. */
.wb-credit-card-err {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2));
}
.wb-credit-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.wb-credit-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-credit-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-credit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
/*
 * The right slot holds whatever the card's state calls for. It never shrinks,
 * so the balance cannot be pushed out by a long account name.
 */
.wb-credit-slot { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; }
/*
 * A fetched balance is itself the button that refetches it. Styled as a value
 * rather than an action — transparent until hovered — so the card shows a
 * number where it previously offered a button, instead of both at once.
 */
.wb-credit-value {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.wb-credit-value:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}
.wb-credit-value:active { background: var(--dsw-alias-interactive-bg-active); }
.wb-credit-value:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.wb-credit-num {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.wb-credit-unit { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.wb-credit-unlimited { font-size: 14px; font-weight: 600; color: var(--dsw-alias-state-success-primary); }
`;
		/**
		* Install the stylesheet once per document.
		*
		* Idempotent by tag id: the slot can mount, collapse and remount, and each mount
		* would otherwise append another copy of every rule.
		*/
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset["plugin"] = "dsh-workbuddy-oauth";
			tag.dataset["pluginCss"] = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/locales.ts
		const zh = {
			title: "WorkBuddy",
			intro: "不依赖桌面 App 的 WorkBuddy 登录与状态。",
			login: "登录",
			loginStarting: "正在获取授权链接…",
			loginOpenLink: "在浏览器中打开以下链接完成授权：",
			loginRefreshHint: "完成后点「我已完成授权」，或直接点上方的「刷新」。",
			loginSucceeded: "登录成功：{label}",
			loginFailed: "登录失败：{reason}",
			loginConfirmAction: "我已完成授权",
			loginCancelled: "已取消授权，未写入任何凭据。",
			statusLoading: "正在读取插件状态…",
			statusUnavailable: "无法读取插件状态（状态接口不可达）。",
			statusUnavailableHint: "插件可能尚未激活，或 DSH 未提供该路由。可运行 /wb-status 确认。",
			retry: "重试",
			regionCn: "国内版",
			regionGlobal: "国际版",
			signedOut: "尚未登录",
			signedInWithModels: "已登录 · {count} 个模型",
			noAccountsInRegion: "该区域尚未登录，模型列表不可用。",
			tabAccounts: "账号",
			tabModels: "模型",
			tabCredits: "积分",
			accountCount: "已登录 {count} 个账号",
			enabledTag: "使用中",
			disabledTag: "已停用",
			tokenRefreshesIn: "{hours} 小时后刷新",
			tokenRefreshesInMinutes: "{minutes} 分钟后刷新",
			tokenRefreshesInDays: "{days} 天后刷新",
			tokenExpired: "已过期",
			enable: "启用",
			disable: "停用",
			logout: "登出",
			logoutConfirmTitle: "确定登出 {label}？",
			logoutConfirmBody: "只删除本插件保存的凭据，不影响上游账号。",
			logoutConfirmAction: "确定登出",
			logoutSucceeded: "已登出：{label}",
			enableSucceeded: "已启用：{label}",
			disableSucceeded: "已停用：{label}",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			maxWindowHintOn: "已开启：{count} 个模型改用最大窗口",
			maxWindowHintOff: "关闭时：{count} 个模型使用较小窗口",
			creditsHeading: "积分余额",
			creditsIntro: "积分只在你点「查询余额」时向上游获取，避免每次打开设置页都发请求。",
			creditsNone: "还没有账号，登录后即可查看积分。",
			queryCredits: "查询余额",
			requeryCredits: "重新查询",
			creditsLoading: "查询中…",
			creditsError: "查询失败：{reason}",
			creditsUnlimited: "不限量",
			creditsUnit: "积分",
			creditsRefreshAll: "全部刷新",
			refresh: "刷新",
			collapse: "折叠",
			expand: "展开",
			cancel: "取消",
			dismiss: "关闭",
			working: "处理中…",
			actionFailed: "{action}失败：{reason}",
			hideModelFailed: "隐藏模型",
			maxWindowFailed: "切换最大窗口",
			logoutFailed: "登出",
			toggleAccountFailed: "切换账号状态",
			probeLabel: "推理档位",
			probeConfirmBody: "检测会向上游发出少量真实请求，可能消耗积分。是否继续？",
			probeConfirmAction: "开始检测",
			probeNoteVerified: "已确认档位：{levels}",
			probeNoteFailed: "检测失败，可稍后重试。",
			probeTooltipIdle: "检测 {model} 支持的推理档位（会消耗少量积分）",
			probeTooltipVerified: "已确认档位：{levels}",
			probeTooltipRunning: "正在检测 {model}…",
			probeTooltipRetry: "上次检测未完成，点击重试",
			probeDismiss: "关闭"
		};
		const en = {
			title: "WorkBuddy",
			intro: "WorkBuddy sign-in and status without the desktop app.",
			login: "Sign in",
			loginStarting: "Requesting an authorization link…",
			loginOpenLink: "Open this link in your browser to authorize:",
			loginRefreshHint: "When done, press \"I have authorized\", or just press Refresh above.",
			loginSucceeded: "Signed in: {label}",
			loginFailed: "Sign-in failed: {reason}",
			loginConfirmAction: "I have authorized",
			loginCancelled: "Authorization cancelled; no credential was written.",
			statusLoading: "Reading plugin status…",
			statusUnavailable: "Cannot read plugin status (the status route is unreachable).",
			statusUnavailableHint: "The plugin may not be active, or DSH does not serve that route. Try /wb-status.",
			retry: "Retry",
			regionCn: "China",
			regionGlobal: "International",
			signedOut: "Not signed in",
			signedInWithModels: "Signed in · {count} models",
			noAccountsInRegion: "This region is not signed in, so its model list is unavailable.",
			tabAccounts: "Accounts",
			tabModels: "Models",
			tabCredits: "Credits",
			accountCount: "{count} account(s) signed in",
			enabledTag: "in use",
			disabledTag: "disabled",
			tokenRefreshesIn: "refreshes in {hours}h",
			tokenRefreshesInMinutes: "refreshes in {minutes}m",
			tokenRefreshesInDays: "refreshes in {days}d",
			tokenExpired: "expired",
			enable: "Enable",
			disable: "Disable",
			logout: "Sign out",
			logoutConfirmTitle: "Sign out of {label}?",
			logoutConfirmBody: "Only the credential stored by this plugin is deleted; the upstream account is untouched.",
			logoutConfirmAction: "Sign out",
			logoutSucceeded: "Signed out: {label}",
			enableSucceeded: "Enabled: {label}",
			disableSucceeded: "Disabled: {label}",
			useMaximumContextWindow: "Use the largest declared context window",
			maxWindowHintOn: "On: {count} model(s) use the largest window",
			maxWindowHintOff: "Off: {count} model(s) use a smaller window",
			creditsHeading: "Credit balance",
			creditsIntro: "Credits are fetched only when you ask, so opening settings sends no upstream request.",
			creditsNone: "No account yet — sign in to see credits.",
			queryCredits: "Check balance",
			requeryCredits: "Check again",
			creditsLoading: "Checking…",
			creditsError: "Check failed: {reason}",
			creditsUnlimited: "Unlimited",
			creditsRefreshAll: "Refresh all",
			creditsUnit: "credits",
			refresh: "Refresh",
			collapse: "Collapse",
			expand: "Expand",
			cancel: "Cancel",
			dismiss: "Dismiss",
			working: "Working…",
			actionFailed: "{action} failed: {reason}",
			hideModelFailed: "Hiding the model",
			maxWindowFailed: "Switching the maximum window",
			logoutFailed: "Signing out",
			toggleAccountFailed: "Toggling the account",
			probeLabel: "Reasoning levels",
			probeConfirmBody: "Detection sends a few real requests upstream and may spend credit. Continue?",
			probeConfirmAction: "Detect",
			probeNoteVerified: "Verified levels: {levels}",
			probeNoteFailed: "Detection failed. Try again later.",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts (spends a little credit)",
			probeTooltipVerified: "Verified levels: {levels}",
			probeTooltipRunning: "Detecting {model}…",
			probeTooltipRetry: "The last detection did not finish. Click to retry.",
			probeDismiss: "Dismiss"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-workbuddy-oauth-client";
		/** The bundle's package name, which is also this half's configuration key. */
		const BUNDLE_NAME = "dsh-workbuddy-oauth";
		/** Required client services. */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-oauth] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own value
		* on success, or `undefined` when it degraded.
		*
		* Guarded at both boundaries where it can throw: the eager
		* `ctx.slots.inject(...)` call (a slot-API shape break) and the deferred slot
		* callback (which the slot runtime invokes long after `apply` has returned).
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/** Register the bundle's browser-side contributions. */
		function apply(ctx) {
			const namespace = "workbuddy";
			guardClientContribution("stylesheet", () => {
				installStyles();
			});
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-oauth: settings copy");
			});
			const t = ctx.locale.bind(namespace);
			guardClientContribution("plugins.bundle.config page", () => {
				ctx.slots.inject("plugins.bundle.config", () => guardClientContribution("plugins.bundle.config page", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-workbuddy-oauth",
					locale: namespace
				}, WorkBuddyConfigPage)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("conversation probe control", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation probe control", () => {
						scope.slots.inject("conversation.input.right", () => guardClientContribution("conversation probe control", () => scope.slots.register({
							name: "conversation.input.right",
							id: "workbuddy-oauth-probe",
							order: 10,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyProbeControl)) ?? NOOP_DISPOSER);
					});
				});
			});
		}
		//#endregion
		exports.BUNDLE_NAME = BUNDLE_NAME;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

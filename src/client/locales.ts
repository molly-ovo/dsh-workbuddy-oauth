/**
 * Copy for the WorkBuddy settings card and the reasoning-level control.
 *
 * @module dsh-workbuddy-oauth/client/locales
 */

/** Dictionary keys this namespace owns. */
export type WorkBuddyLocaleKey =
  // Card chrome
  | 'title'
  | 'intro'
  // Sign-in
  | 'login'
  | 'loginStarting'
  | 'loginOpenLink'
  | 'loginRefreshHint'
  | 'loginSucceeded'
  | 'loginFailed'
  | 'loginConfirmAction'
  | 'loginCancelled'
  // Loading and failure of the status document itself
  | 'statusLoading'
  | 'statusUnavailable'
  | 'statusUnavailableHint'
  | 'retry'
  // Regions
  | 'regionCn'
  | 'regionGlobal'
  | 'signedOut'
  | 'signedInWithModels'
  | 'noAccountsInRegion'
  // Tabs
  | 'tabAccounts'
  | 'tabModels'
  | 'tabCredits'
  // Accounts
  | 'accountCount'
  | 'enabledTag'
  | 'disabledTag'
  | 'tokenRefreshesIn'
  | 'tokenRefreshesInMinutes'
  | 'tokenRefreshesInDays'
  | 'tokenExpired'
  | 'enable'
  | 'disable'
  | 'logout'
  | 'logoutConfirmTitle'
  | 'logoutConfirmBody'
  | 'logoutConfirmAction'
  | 'logoutSucceeded'
  | 'enableSucceeded'
  | 'disableSucceeded'
  // Models
  | 'useMaximumContextWindow'
  | 'maxWindowHintOn'
  | 'maxWindowHintOff'
  // Credits
  | 'creditsHeading'
  | 'creditsIntro'
  | 'creditsNone'
  | 'queryCredits'
  | 'requeryCredits'
  | 'creditsLoading'
  | 'creditsError'
  | 'creditsUnlimited'
  | 'creditsUnit'
  | 'creditsRefreshAll'
  // Shared
  | 'refresh'
  | 'collapse'
  | 'expand'
  | 'cancel'
  | 'dismiss'
  | 'working'
  | 'actionFailed'
  | 'hideModelFailed'
  | 'maxWindowFailed'
  | 'logoutFailed'
  | 'toggleAccountFailed'
  // Reasoning-level control (composer)
  | 'probeLabel'
  | 'probeConfirmBody'
  | 'probeConfirmAction'
  | 'probeNoteVerified'
  | 'probeNoteFailed'
  | 'probeTooltipIdle'
  | 'probeTooltipVerified'
  | 'probeTooltipRunning'
  | 'probeTooltipRetry'
  | 'probeDismiss'

export const zh: Record<WorkBuddyLocaleKey, string> = {
  title: 'WorkBuddy',
  intro: '不依赖桌面 App 的 WorkBuddy 登录与状态。',

  login: '登录',
  loginStarting: '正在获取授权链接…',
  loginOpenLink: '在浏览器中打开以下链接完成授权：',
  loginRefreshHint: '完成后点「我已完成授权」，或直接点上方的「刷新」。',
  loginSucceeded: '登录成功：{label}',
  loginFailed: '登录失败：{reason}',
  loginConfirmAction: '我已完成授权',
  loginCancelled: '已取消授权，未写入任何凭据。',

  statusLoading: '正在读取插件状态…',
  statusUnavailable: '无法读取插件状态（状态接口不可达）。',
  statusUnavailableHint: '插件可能尚未激活，或 DSH 未提供该路由。可运行 /wb-status 确认。',
  retry: '重试',

  regionCn: '国内版',
  regionGlobal: '国际版',
  signedOut: '尚未登录',
  signedInWithModels: '已登录 · {count} 个模型',
  noAccountsInRegion: '该区域尚未登录，模型列表不可用。',

  tabAccounts: '账号',
  tabModels: '模型',
  tabCredits: '积分',
  accountCount: '已登录 {count} 个账号',
  enabledTag: '使用中',
  disabledTag: '已停用',
  tokenRefreshesIn: '{hours} 小时后刷新',
  tokenRefreshesInMinutes: '{minutes} 分钟后刷新',
  tokenRefreshesInDays: '{days} 天后刷新',
  tokenExpired: '已过期',
  enable: '启用',
  disable: '停用',
  logout: '登出',
  logoutConfirmTitle: '确定登出 {label}？',
  logoutConfirmBody: '只删除本插件保存的凭据，不影响上游账号。',
  logoutConfirmAction: '确定登出',
  logoutSucceeded: '已登出：{label}',
  enableSucceeded: '已启用：{label}',
  disableSucceeded: '已停用：{label}',
  useMaximumContextWindow: '使用上游声明的最大上下文窗口',
  maxWindowHintOn: '已开启：{count} 个模型改用最大窗口',
  maxWindowHintOff: '关闭时：{count} 个模型使用较小窗口',

  creditsHeading: '积分余额',
  creditsIntro: '积分只在你点「查询余额」时向上游获取，避免每次打开设置页都发请求。',
  creditsNone: '还没有账号，登录后即可查看积分。',
  queryCredits: '查询余额',
  requeryCredits: '重新查询',
  creditsLoading: '查询中…',
  creditsError: '查询失败：{reason}',
  creditsUnlimited: '不限量',
  creditsUnit: '积分',
  creditsRefreshAll: '全部刷新',

  refresh: '刷新',
  collapse: '折叠',
  expand: '展开',
  cancel: '取消',
  dismiss: '关闭',
  working: '处理中…',
  actionFailed: '{action}失败：{reason}',
  hideModelFailed: '隐藏模型',
  maxWindowFailed: '切换最大窗口',
  logoutFailed: '登出',
  toggleAccountFailed: '切换账号状态',
  probeLabel: '推理档位',
  probeConfirmBody: '检测会向上游发出少量真实请求，可能消耗积分。是否继续？',
  probeConfirmAction: '开始检测',
  probeNoteVerified: '已确认档位：{levels}',
  probeNoteFailed: '检测失败，可稍后重试。',
  probeTooltipIdle: '检测 {model} 支持的推理档位（会消耗少量积分）',
  probeTooltipVerified: '已确认档位：{levels}',
  probeTooltipRunning: '正在检测 {model}…',
  probeTooltipRetry: '上次检测未完成，点击重试',
  probeDismiss: '关闭',
}

export const en: Record<WorkBuddyLocaleKey, string> = {
  title: 'WorkBuddy',
  intro: 'WorkBuddy sign-in and status without the desktop app.',

  login: 'Sign in',
  loginStarting: 'Requesting an authorization link…',
  loginOpenLink: 'Open this link in your browser to authorize:',
  loginRefreshHint: 'When done, press "I have authorized", or just press Refresh above.',
  loginSucceeded: 'Signed in: {label}',
  loginFailed: 'Sign-in failed: {reason}',
  loginConfirmAction: 'I have authorized',
  loginCancelled: 'Authorization cancelled; no credential was written.',

  statusLoading: 'Reading plugin status…',
  statusUnavailable: 'Cannot read plugin status (the status route is unreachable).',
  statusUnavailableHint: 'The plugin may not be active, or DSH does not serve that route. Try /wb-status.',
  retry: 'Retry',

  regionCn: 'China',
  regionGlobal: 'International',
  signedOut: 'Not signed in',
  signedInWithModels: 'Signed in · {count} models',
  noAccountsInRegion: 'This region is not signed in, so its model list is unavailable.',

  tabAccounts: 'Accounts',
  tabModels: 'Models',
  tabCredits: 'Credits',
  accountCount: '{count} account(s) signed in',
  enabledTag: 'in use',
  disabledTag: 'disabled',
  tokenRefreshesIn: 'refreshes in {hours}h',
  tokenRefreshesInMinutes: 'refreshes in {minutes}m',
  tokenRefreshesInDays: 'refreshes in {days}d',
  tokenExpired: 'expired',
  enable: 'Enable',
  disable: 'Disable',
  logout: 'Sign out',
  logoutConfirmTitle: 'Sign out of {label}?',
  logoutConfirmBody: 'Only the credential stored by this plugin is deleted; the upstream account is untouched.',
  logoutConfirmAction: 'Sign out',
  logoutSucceeded: 'Signed out: {label}',
  enableSucceeded: 'Enabled: {label}',
  disableSucceeded: 'Disabled: {label}',
  useMaximumContextWindow: 'Use the largest declared context window',
  maxWindowHintOn: 'On: {count} model(s) use the largest window',
  maxWindowHintOff: 'Off: {count} model(s) use a smaller window',

  creditsHeading: 'Credit balance',
  creditsIntro: 'Credits are fetched only when you ask, so opening settings sends no upstream request.',
  creditsNone: 'No account yet — sign in to see credits.',
  queryCredits: 'Check balance',
  requeryCredits: 'Check again',
  creditsLoading: 'Checking…',
  creditsError: 'Check failed: {reason}',
  creditsUnlimited: 'Unlimited',
  creditsRefreshAll: 'Refresh all',
  creditsUnit: 'credits',

  refresh: 'Refresh',
  collapse: 'Collapse',
  expand: 'Expand',
  cancel: 'Cancel',
  dismiss: 'Dismiss',
  working: 'Working…',
  actionFailed: '{action} failed: {reason}',
  hideModelFailed: 'Hiding the model',
  maxWindowFailed: 'Switching the maximum window',
  logoutFailed: 'Signing out',
  toggleAccountFailed: 'Toggling the account',
  probeLabel: 'Reasoning levels',
  probeConfirmBody: 'Detection sends a few real requests upstream and may spend credit. Continue?',
  probeConfirmAction: 'Detect',
  probeNoteVerified: 'Verified levels: {levels}',
  probeNoteFailed: 'Detection failed. Try again later.',
  probeTooltipIdle: 'Detect the reasoning levels {model} accepts (spends a little credit)',
  probeTooltipVerified: 'Verified levels: {levels}',
  probeTooltipRunning: 'Detecting {model}…',
  probeTooltipRetry: 'The last detection did not finish. Click to retry.',
  probeDismiss: 'Dismiss',
}

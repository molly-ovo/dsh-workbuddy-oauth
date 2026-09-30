/**
 * Copy for the WorkBuddy settings card and the reasoning-level control.
 *
 * @module dsh-workbuddy-standalone/client/locales
 */

/** Dictionary keys this namespace owns. */
export type WorkBuddyLocaleKey =
  | 'title'
  | 'intro'
  | 'signedOut'
  | 'signedInAs'
  | 'regionCn'
  | 'regionGlobal'
  | 'expiresSoon'
  | 'probeRunning'
  | 'probeIdle'
  | 'probeVerified'
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
  | 'cancel'
  | 'login'
  | 'loginStarting'
  | 'loginOpenLink'
  | 'loginRefreshHint'
  | 'loginSucceeded'
  | 'loginFailed'
  | 'loginState'
  | 'noAccounts'
  | 'accountCount'
  | 'signedInWithModels'
  | 'tabAccounts'
  | 'tabModels'
  | 'modelsHeading'
  | 'contextWindowLabel'
  | 'hideModel'
  | 'modelVisibilityIntro'
  | 'useMaximumContextWindow'
  | 'expand'
  | 'collapse'
  | 'creditsHeading'
  | 'queryCredits'
  | 'creditsLoading'
  | 'creditsError'
  | 'creditsTotal'
  | 'creditsUnlimited'
  | 'creditsReset'
  | 'creditsUnknownSize'
  | 'models'
  | 'noModels'
  | 'refresh'
  | 'enable'
  | 'disable'
  | 'enabledTag'
  | 'disabledTag'
  | 'logout'
  | 'logoutConfirm'
  | 'logoutConfirmAction'
  | 'logoutSucceeded'
  | 'enableSucceeded'
  | 'disableSucceeded'
  | 'working'

export const zh: Record<WorkBuddyLocaleKey, string> = {
  title: 'WorkBuddy',
  intro: '不依赖桌面 App 的 WorkBuddy 登录与状态。',
  signedOut: '尚未登录',
  signedInAs: '已登录：{label}',
  regionCn: '国内版',
  regionGlobal: '国际版',
  expiresSoon: '令牌 {time} 后需刷新',
  probeRunning: '正在检测…',
  probeIdle: '未检测',
  probeVerified: '已确认可用档位',
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
  cancel: '取消',
  login: '登录',
  loginStarting: '正在获取授权链接…',
  loginOpenLink: '请在浏览器中打开以下链接完成授权：',
  loginRefreshHint: '若已在网页成功登录，点「刷新」完成登录。',
  loginSucceeded: '登录成功：{label}',
  loginFailed: '登录失败：{reason}',
  loginState: '登录状态',
  noAccounts: '尚未登录任何账号',
  accountCount: '已登录 {count} 个账号',
  signedInWithModels: '已登录 · {count} 个模型',
  tabAccounts: '账号',
  tabModels: '模型',
  modelsHeading: '模型',
  contextWindowLabel: '上下文',
  hideModel: '隐藏',
  modelVisibilityIntro: '取消勾选可把模型从选择器隐藏；正在使用该模型的对话不受影响。',
  useMaximumContextWindow: '使用上游声明的最大上下文窗口',
  expand: '展开',
  collapse: '收起',
  creditsHeading: '积分余额',
  queryCredits: '查询余额',
  creditsLoading: '查询中…',
  creditsError: '查询失败：{reason}',
  creditsTotal: '剩余 {total}',
  creditsUnlimited: '不限量',
  creditsReset: '重置于 {time}',
  creditsUnknownSize: '剩余 {remain}（总量未知）',
  models: '{count} 个模型',
  noModels: '无可用模型',
  refresh: '刷新',
  enable: '启用',
  disable: '停用',
  enabledTag: '使用中',
  disabledTag: '已停用',
  logout: '登出',
  logoutConfirm: '确定登出 {label}？只删除本插件保存的凭据，不影响上游账号。',
  logoutConfirmAction: '登出',
  logoutSucceeded: '已登出：{label}',
  enableSucceeded: '已启用：{label}',
  disableSucceeded: '已停用：{label}',
  working: '处理中…',
}

export const en: Record<WorkBuddyLocaleKey, string> = {
  title: 'WorkBuddy',
  intro: 'WorkBuddy sign-in and status without the desktop app.',
  signedOut: 'Not signed in',
  signedInAs: 'Signed in as {label}',
  regionCn: 'China',
  regionGlobal: 'International',
  expiresSoon: 'token refreshes in {time}',
  probeRunning: 'Detecting…',
  probeIdle: 'Not detected',
  probeVerified: 'Verified levels',
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
  cancel: 'Cancel',
  login: 'Sign in',
  loginStarting: 'Requesting an authorization link…',
  loginOpenLink: 'Open this link in your browser to authorize:',
  loginRefreshHint: 'If you already signed in, press "Refresh" to finish.',
  loginSucceeded: 'Signed in: {label}',
  loginFailed: 'Sign-in failed: {reason}',
  loginState: 'Sign-in state',
  noAccounts: 'No account signed in',
  accountCount: '{count} account(s) signed in',
  signedInWithModels: 'Signed in · {count} models',
  tabAccounts: 'Accounts',
  tabModels: 'Models',
  modelsHeading: 'Models',
  contextWindowLabel: 'Context',
  hideModel: 'Hide',
  modelVisibilityIntro: 'Uncheck a model to hide it from the picker; chats already using it keep working.',
  useMaximumContextWindow: 'Use the largest declared context window',
  expand: 'Expand',
  collapse: 'Collapse',
  creditsHeading: 'Credit balance',
  queryCredits: 'Check balance',
  creditsLoading: 'Checking…',
  creditsError: 'Check failed: {reason}',
  creditsTotal: '{total} remaining',
  creditsUnlimited: 'Unlimited',
  creditsReset: 'Resets {time}',
  creditsUnknownSize: '{remain} remaining',
  models: '{count} models',
  noModels: 'No models available',
  refresh: 'Refresh',
  enable: 'Enable',
  disable: 'Disable',
  enabledTag: 'in use',
  disabledTag: 'disabled',
  logout: 'Sign out',
  logoutConfirm: 'Sign out of {label}? Only the credential stored by this plugin is deleted; the upstream account is untouched.',
  logoutConfirmAction: 'Sign out',
  logoutSucceeded: 'Signed out: {label}',
  enableSucceeded: 'Enabled: {label}',
  disableSucceeded: 'Disabled: {label}',
  working: 'Working…',
}

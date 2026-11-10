/**
 * Panel strings (fr/en) and locale resolution. Concatenated into the browser
 * artifact by scripts/build-client.mjs: every name here is global to the bundle.
 *
 * @module dsh-agent-board/client/ui/strings
 */

const DAB_STRINGS = {
  fr: {
    title: 'Agent Board',
    mode: 'Orchestrateur',
    off: 'Arrêt',
    supervised: 'Supervisé',
    autonomous: 'Autonome',
    stop: 'Arrêter les exécutions',
    stopNone: 'Aucune exécution du board en cours',
    orchestratorDown: 'API orchestrateur injoignable : contrôle indisponible',
    compact: 'Cartes compactes',
    treeView: 'Arbre',
    refresh: 'Rafraîchir',
    search: 'Rechercher un agent, un projet, une tâche…',
    allProjects: 'Tous les projets',
    filterAttention: 'À traiter',
    filterRecent: 'Récents 24 h',
    filterAll: 'Tout',
    history: 'Historique',
    running: 'en cours',
    waiting: 'en attente',
    unread: 'non lus',
    failed: 'en erreur',
    shown: 'affichés',
    of: 'sur',
    statusRunning: 'En cours',
    statusWaiting: 'Attend votre action',
    statusRecovering: 'Récupération en cours',
    statusUnavailable: 'Agent indisponible',
    statusUnread: 'Terminé — non consulté',
    statusRead: 'Terminé',
    statusFailed: 'Échec',
    statusIdle: 'Inactif',
    statusUnknown: 'Inconnu / déconnecté',
    groupActive: 'sous-agents actifs',
    waitingApproval: 'Attend votre approbation',
    waitingQuestion: 'Attend votre réponse',
    waitingPlan: 'Attend votre revue du plan',
    waitingUnknown: 'Attend une intervention',
    open: 'Ouvrir',
    openSession: 'Ouvrir la session',
    openParent: 'Ouvrir le parent',
    openFailed: 'Impossible d\u2019ouvrir cette session via le routeur DSH',
    finalAnswer: 'Dernière ligne de la réponse finale',
    noFinal: 'Pas encore de réponse finale.',
    activity: 'Activité',
    previousSession: 'Session précédente',
    routeHistory: 'Changements de route',
    statusReason: 'Raison du statut',
    recovery: 'Reprise',
    resume: 'Reprendre',
    stoppedNotice: 'Arrêté par l’opérateur — aucune nouvelle délégation',
    secondaryInstance: 'Instance secondaire (lecture seule) : un autre hôte possède l’état.',
    turns: 'tours',
    steps: 'étapes',
    seeMore: 'Voir plus',
    seeLess: 'Réduire',
    close: 'Fermer',
    collapse: 'Replier la branche',
    expand: 'Déplier la branche',
    showHidden: 'afficher',
    hidden: 'masqués',
    children: 'sous-agents',
    subagent: 'sous-agent',
    parent: 'Parent',
    project: 'Projet',
    model: 'Modèle',
    task: 'Tâche',
    directory: 'Répertoire',
    session: 'Session',
    goal: 'Objectif',
    orphan: 'parent inconnu',
    cycle: 'parenté invalide (cycle)',
    unassigned: 'Non attribué',
    emptyAttention: 'Rien à traiter : aucun agent en cours, en attente ou fraîchement terminé.',
    emptyHint: 'L\u2019historique reste accessible via « Historique » ou la recherche.',
    emptySearch: 'Aucun agent ne correspond.',
    moreTrees: 'Afficher {n} arbre(s) de plus',
    historyTitle: 'Historique des sessions',
    historyHint: 'Sessions inactives, consultées ou archivées. Rien n\u2019est supprimé ni archivé par le board.',
    loadMore: 'Charger plus',
    archived: 'archivée',
    noModel: 'modèle inconnu',
    proposals: 'Proposition en attente',
    approve: 'Approuver',
    reject: 'Refuser',
    executions: 'Exécutions du board',
    restore: 'Reprise après redémarrage',
    resumed: 'interrompue — reprise contrôlée requise',
    offNotice: 'Observation seule',
    supervisedNotice: 'Les propositions attendent votre accord',
    autonomousNotice: 'Exécute dans le mandat configuré',
    orchestratorState: 'État orchestrateur et adaptateurs',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    notLive: 'non validé live',
    keyboardHint: 'Entrée : ouvrir · Espace : aperçu · double-clic : ouvrir',
    projects: 'Projets',
    ago: 'il y a',
  },
  en: {
    title: 'Agent Board',
    mode: 'Orchestrator',
    off: 'Off',
    supervised: 'Supervised',
    autonomous: 'Autonomous',
    stop: 'Stop executions',
    stopNone: 'No board execution in flight',
    orchestratorDown: 'Orchestrator API unreachable: control unavailable',
    compact: 'Compact cards',
    treeView: 'Tree',
    refresh: 'Refresh',
    search: 'Search an agent, project, task…',
    allProjects: 'All projects',
    filterAttention: 'Needs attention',
    filterRecent: 'Recent 24 h',
    filterAll: 'All',
    history: 'History',
    running: 'running',
    waiting: 'waiting',
    unread: 'unread',
    failed: 'failed',
    shown: 'shown',
    of: 'of',
    statusRunning: 'Running',
    statusWaiting: 'Needs your action',
    statusRecovering: 'Recovering',
    statusUnavailable: 'Agent unavailable',
    statusUnread: 'Finished — not viewed',
    statusRead: 'Finished',
    statusFailed: 'Failed',
    statusIdle: 'Idle',
    statusUnknown: 'Unknown / disconnected',
    groupActive: 'active sub-agents',
    waitingApproval: 'Waiting for your approval',
    waitingQuestion: 'Waiting for your answer',
    waitingPlan: 'Waiting for your plan review',
    waitingUnknown: 'Waiting for an intervention',
    open: 'Open',
    openSession: 'Open session',
    openParent: 'Open parent',
    openFailed: 'This session cannot be opened through the DSH router',
    finalAnswer: 'Last line of the final answer',
    noFinal: 'No final answer yet.',
    activity: 'Activity',
    previousSession: 'Previous session',
    routeHistory: 'Route changes',
    statusReason: 'Status reason',
    recovery: 'Recovery',
    resume: 'Resume',
    stoppedNotice: 'Stopped by the operator — no new delegation',
    secondaryInstance: 'Secondary instance (read-only): another host owns the state.',
    turns: 'turns',
    steps: 'steps',
    seeMore: 'See more',
    seeLess: 'Less',
    close: 'Close',
    collapse: 'Collapse branch',
    expand: 'Expand branch',
    showHidden: 'show',
    hidden: 'hidden',
    children: 'sub-agents',
    subagent: 'sub-agent',
    parent: 'Parent',
    project: 'Project',
    model: 'Model',
    task: 'Task',
    directory: 'Directory',
    session: 'Session',
    goal: 'Goal',
    orphan: 'unknown parent',
    cycle: 'invalid parentage (cycle)',
    unassigned: 'Unassigned',
    emptyAttention: 'Nothing to handle: no agent running, waiting or freshly finished.',
    emptyHint: 'History stays available through “History” or the search.',
    emptySearch: 'No agent matches.',
    moreTrees: 'Show {n} more tree(s)',
    historyTitle: 'Session history',
    historyHint: 'Idle, viewed or archived sessions. The board never deletes or archives anything.',
    loadMore: 'Load more',
    archived: 'archived',
    noModel: 'unknown model',
    proposals: 'Pending proposal',
    approve: 'Approve',
    reject: 'Reject',
    executions: 'Board executions',
    restore: 'Restart reconciliation',
    resumed: 'interrupted — controlled resume required',
    offNotice: 'Observation only',
    supervisedNotice: 'Proposals wait for your approval',
    autonomousNotice: 'Runs inside the configured mandate',
    orchestratorState: 'Orchestrator and adapters status',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    notLive: 'not validated live',
    keyboardHint: 'Enter: open · Space: preview · double-click: open',
    projects: 'Projects',
    ago: 'ago',
  },
}

let DAB_LANG = 'en'

function dabResolveLocale(ctx) {
  try {
    const snapshot = ctx?.get?.('locale')?.getLocale?.()
    const active = snapshot?.active
    const id = typeof active === 'string' ? active : active?.id
    // 'auto' / 'system' (or anything not a language tag) defers to the document.
    if (typeof id === 'string' && /^(fr|en|zh)/i.test(id)) return id.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch { /* fall through */ }
  try {
    const lang = String(globalThis.document?.documentElement?.lang || globalThis.navigator?.language || 'en')
    return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch {
    return 'en'
  }
}

function dabT(key, vars) {
  const raw = (DAB_STRINGS[DAB_LANG] ?? DAB_STRINGS.en)[key] ?? DAB_STRINGS.en[key] ?? key
  if (vars === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
}

const DAB_STATUS_TEXT = {
  running: 'statusRunning',
  waiting_user: 'statusWaiting',
  recovering: 'statusRecovering',
  finished_unread: 'statusUnread',
  finished_read: 'statusRead',
  failed: 'statusFailed',
  idle: 'statusIdle',
  unknown: 'statusUnknown',
  unavailable: 'statusUnavailable',
}

function dabStatusLabel(status) {
  return dabT(DAB_STATUS_TEXT[status] ?? 'statusUnknown')
}

function dabWaitingLabel(action) {
  if (action === 'approval') return dabT('waitingApproval')
  if (action === 'question') return dabT('waitingQuestion')
  if (action === 'plan-review') return dabT('waitingPlan')
  return dabT('waitingUnknown')
}

function dabFormatAge(at, now = Date.now()) {
  if (!Number.isFinite(Number(at)) || Number(at) <= 0) return ''
  const seconds = Math.max(0, Math.round((now - Number(at)) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} j`
}

function dabModelText(model) {
  if (model === null || model === undefined || (model.model === '—' && model.provider === '—')) return null
  const name = typeof model.model === 'string' && model.model !== '—' ? model.model : '?'
  return name
}

function dabModelTitle(model) {
  if (model === null || model === undefined || model.source === 'unknown') return dabT('noModel')
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  return `${model.provider}/${model.model}${effort}`
}

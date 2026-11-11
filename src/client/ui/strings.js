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
    statusInterrupted: 'Interrompu',
    statusProviderUnavailable: 'Fournisseur indisponible',
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
    contest: 'parenté contestée',
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
    provider: 'Fournisseur',
    modelNative: 'natif',
    modelAssignment: 'board',
    modelSource: 'Source du modèle',
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
    stateShort: 'État',
    moreControls: 'Filtres et orchestrateur',
    dismiss: 'Retirer du tableau',
    undismiss: 'Remettre dans le tableau',
    dismissHint: 'Masque cette session des vues « À traiter » et « Récents » (la session n’est pas supprimée ; visible via « Tout » ou la recherche)',
    viewLabel: 'Vue',
    viewModeLabel: 'Mode de vue',
    filterLabel: 'Filtre',
    orchestratorLabel: 'Orchestrateur',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    notLive: 'non validé live',
    keyboardHint: 'Entrée : ouvrir · Espace : aperçu · double-clic : ouvrir',
    projects: 'Projets',
    ago: 'il y a',
    // ---- supervision / hiérarchie / identités (GOAL 4)
    role: 'Rôle',
    roleAll: 'Tous les rôles',
    roleGeneric: 'Générique',
    roleFamilyLabel: 'Famille de rôle',
    roleDeclared: 'Rôle déclaré',
    roleDeclaredAlias: 'rôle déclaré (alias)',
    roleInferred: 'déduit',
    roleInferredDefault: 'Rôle déduit par défaut (aucun rôle déclaré ni mot-clé de rôle)',
    roleInferredFrom: 'Rôle déduit du texte déclaré (« {signal} »)',
    noDeclaredRole: 'Rôle non déclaré',
    genericIdentity: 'Identité générique',
    familyGovernance: 'Gouvernance / connaissances',
    familyCoordination: 'Coordination / supervision',
    familyExecution: 'Production / optimisation',
    familyQuality: 'Revue / audit',
    familyValidation: 'Validation / tests',
    familyProtection: 'Protection / règles',
    statusFilterLabel: 'Statut',
    statusAll: 'Tous les statuts',
    viewProjects: 'Projets',
    viewHierarchy: 'Hiérarchie',
    taskStateFilterLabel: 'État Task Board',
    taskStateAll: 'Tous les états',
    taskStateUnavailable: 'Task Board non lu',
    taskStateUnavailable: 'Task Board indisponible',
    taskStateTitle: 'État de la tâche liée (Task Board)',
    taskTodo: 'À faire',
    taskInProgress: 'En cours',
    taskInReview: 'En revue',
    taskBlocked: 'Bloquée',
    taskDone: 'Terminée',
    taskCanceled: 'Annulée',
    taskArchived: 'Archivée',
    agent: 'Agent',
    agents: 'agents',
    // Count forms (fr): the UI never prints "1 projets".
    projectSingular: 'projet',
    projectPlural: 'projets',
    agentSingular: 'agent',
    agentPlural: 'agents',
    unreadSingular: 'non lu',
    unreadPlural: 'non lus',
    interruptedSingular: 'interrompu',
    interruptedPlural: 'interrompus',
    blockedSingular: 'bloqué',
    blockedPlural: 'bloqués',
    turnSingular: 'tour',
    turnPlural: 'tours',
    stepSingular: 'étape',
    stepPlural: 'étapes',
    shownSingular: 'affiché',
    shownPlural: 'affichés',
    supervision: 'Supervision',
    supervisionLayer: 'Couche de supervision (non un agent)',
    superOrchestrator: 'Super-orchestrateur',
    supervisionExpand: 'Afficher la supervision',
    supervisionCollapse: 'Masquer la supervision',
    supervisionUnavailable: 'Supervision non publiée par l’hôte : structure et comptages réels, capacités indisponibles.',
    taskboardUnavailable: 'Task Board indisponible pour la lecture',
    supervisionWorkspace: 'Espace de travail',
    supervisionMode: 'Mode',
    supervisionBlocked: 'bloqués',
    supervisionDependencies: 'Dépendances inter-projets',
    supervisionNoDependencies: 'Aucune dépendance inter-projets connue.',
    supervisionBlocks: 'Blocages',
    supervisionNoBlocks: 'Aucun blocage connu.',
    supervisionRecommendations: 'Recommandations',
    supervisionNoRecommendations: 'Aucune recommandation.',
    recommendationNotApplied: 'proposition — non appliquée',
    recommendationDelegate: 'Délégation',
    recommendationUnblock: 'Déblocage',
    recommendationPriority: 'Priorité',
    recommendationReassign: 'Réaffectation',
    supervisionCapabilities: 'Capacités',
    supervisionCapabilityReason: 'Raison',
    supervisionStatusActive: 'Actif',
    supervisionStatusIdle: 'Inactif (observation)',
    supervisionStatusBlocked: 'Bloqué',
    supervisionStatusUnknown: 'Inconnu',
    supervisionSynthetic: 'Couche de supervision de l’hôte : aucune session ne lui correspond.',
    supervisionDelegation: 'Délégation : {inFlight} en cours · profondeur {depth} · {concurrent} simultanées · {hourly}/h',
    capObserve: 'Observer',
    capRecommend: 'Recommander',
    capDelegate: 'Déléguer',
    capReassign: 'Réaffecter',
    capPriority: 'Prioriser',
    capReceiveReports: 'Rapports d’orchestrateur',
    capKanbanWrite: 'Écriture Task Board',
    capabilityAvailable: 'Disponible',
    capabilityGated: 'Sous conditions',
    capabilityProposalOnly: 'Proposition seulement',
    capabilityUnavailable: 'Non disponible',
    capReasonSupervisionUnavailable: 'hôte : supervision non publiée',
    capReasonGated: 'soumise aux limites et à l’accord de l’opérateur',
    capReasonProposalOnly: 'aucune écriture : proposition uniquement',
    capReasonReadOnly: 'Task Board en lecture seule depuis le board',
    capReasonNoChannel: 'aucun canal de rapport d’orchestrateur dans cette version',
    capReasonDisabled: 'désactivée par la politique',
    capReasonUnknown: 'raison non fournie par l’hôte',
    hierarchy: 'Hiérarchie',
    hierarchyOrchestratorMissing: 'Aucun orchestrateur déclaré',
    hierarchyOrchestratorMissingHint: 'Aucun agent de ce projet ne déclare le rôle orchestrator : le board n’en crée jamais.',
    hierarchyAgentsCount: '{n} agents',
    hierarchyHiddenByFilter: '{n} masqués par le filtre',
    hierarchyNoAgents: 'Aucun agent visible dans ce projet.',
    hierarchyEmpty: 'Aucun agent ne correspond aux filtres.',
    hierarchyTeamOf: 'Équipe de {name}',
    activityReal: 'Activité réelle : {activity}',
    emptyFiltered: 'Aucun agent ne correspond aux filtres actifs.',
    clearFilters: 'Effacer les filtres',
    noActivity: 'Activité inconnue',
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
    statusInterrupted: 'Interrupted',
    statusProviderUnavailable: 'Provider unavailable',
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
    contest: 'contested parentage',
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
    provider: 'Provider',
    modelNative: 'native',
    modelAssignment: 'board',
    modelSource: 'Model source',
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
    stateShort: 'Status',
    moreControls: 'Filters and orchestrator',
    dismiss: 'Remove from board',
    undismiss: 'Put back on board',
    dismissHint: 'Hides this session from the Attention and Recent views (the session is not deleted; still visible in All or search)',
    viewLabel: 'View',
    viewModeLabel: 'View mode',
    filterLabel: 'Filter',
    orchestratorLabel: 'Orchestrator',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    notLive: 'not validated live',
    keyboardHint: 'Enter: open · Space: preview · double-click: open',
    projects: 'Projects',
    ago: 'ago',
    // ---- supervision / hierarchy / identities (GOAL 4)
    role: 'Role',
    roleAll: 'All roles',
    roleGeneric: 'Generic',
    roleFamilyLabel: 'Role family',
    roleDeclared: 'Declared role',
    roleDeclaredAlias: 'declared role (alias)',
    roleInferred: 'deduced',
    roleInferredDefault: 'Role deduced by default (no declared role, no role keyword)',
    roleInferredFrom: 'Role deduced from declared text (“{signal}”)',
    noDeclaredRole: 'No declared role',
    genericIdentity: 'Generic identity',
    familyGovernance: 'Governance / knowledge',
    familyCoordination: 'Coordination / monitoring',
    familyExecution: 'Production / optimization',
    familyQuality: 'Review / audit',
    familyValidation: 'Validation / testing',
    familyProtection: 'Protection / rules',
    statusFilterLabel: 'Status',
    statusAll: 'All statuses',
    viewProjects: 'Projects',
    viewHierarchy: 'Hierarchy',
    taskStateFilterLabel: 'Task Board state',
    taskStateAll: 'All states',
    taskStateUnavailable: 'Task Board not read',
    taskStateUnavailable: 'Task Board unavailable',
    taskStateTitle: 'Linked Task Board state',
    taskTodo: 'Todo',
    taskInProgress: 'In progress',
    taskInReview: 'In review',
    taskBlocked: 'Blocked',
    taskDone: 'Done',
    taskCanceled: 'Canceled',
    taskArchived: 'Archived',
    agent: 'Agent',
    agents: 'agents',
    // Count forms (en): 1 project / 2 projects.
    projectSingular: 'project',
    projectPlural: 'projects',
    agentSingular: 'agent',
    agentPlural: 'agents',
    unreadSingular: 'unread',
    unreadPlural: 'unread',
    interruptedSingular: 'interrupted',
    interruptedPlural: 'interrupted',
    blockedSingular: 'blocked',
    blockedPlural: 'blocked',
    turnSingular: 'turn',
    turnPlural: 'turns',
    stepSingular: 'step',
    stepPlural: 'steps',
    shownSingular: 'shown',
    shownPlural: 'shown',
    supervision: 'Supervision',
    supervisionLayer: 'Supervision layer (not an agent)',
    superOrchestrator: 'Super orchestrator',
    supervisionExpand: 'Show supervision',
    supervisionCollapse: 'Hide supervision',
    supervisionUnavailable: 'Supervision not published by the host: real structure and counts, capabilities unavailable.',
    taskboardUnavailable: 'Task Board unavailable for reading',
    supervisionWorkspace: 'Workspace',
    supervisionMode: 'Mode',
    supervisionBlocked: 'blocked',
    supervisionDependencies: 'Cross-project dependencies',
    supervisionNoDependencies: 'No known cross-project dependency.',
    supervisionBlocks: 'Blocking items',
    supervisionNoBlocks: 'No known blocking item.',
    supervisionRecommendations: 'Recommendations',
    supervisionNoRecommendations: 'No recommendation.',
    recommendationNotApplied: 'proposal — not applied',
    recommendationDelegate: 'Delegation',
    recommendationUnblock: 'Unblock',
    recommendationPriority: 'Priority',
    recommendationReassign: 'Reassignment',
    supervisionCapabilities: 'Capabilities',
    supervisionCapabilityReason: 'Reason',
    supervisionStatusActive: 'Active',
    supervisionStatusIdle: 'Idle (observing)',
    supervisionStatusBlocked: 'Blocked',
    supervisionStatusUnknown: 'Unknown',
    supervisionSynthetic: 'Host supervision layer: no session backs it.',
    supervisionDelegation: 'Delegation: {inFlight} in flight · depth {depth} · {concurrent} concurrent · {hourly}/h',
    capObserve: 'Observe',
    capRecommend: 'Recommend',
    capDelegate: 'Delegate',
    capReassign: 'Reassign',
    capPriority: 'Set priority',
    capReceiveReports: 'Orchestrator reports',
    capKanbanWrite: 'Task Board writes',
    capabilityAvailable: 'Available',
    capabilityGated: 'Gated',
    capabilityProposalOnly: 'Proposal only',
    capabilityUnavailable: 'Unavailable',
    capReasonSupervisionUnavailable: 'host: supervision not published',
    capReasonGated: 'subject to limits and operator approval',
    capReasonProposalOnly: 'no write path: proposal only',
    capReasonReadOnly: 'Task Board is read-only from the board',
    capReasonNoChannel: 'no orchestrator report channel in this build',
    capReasonDisabled: 'disabled by policy',
    capReasonUnknown: 'no reason provided by the host',
    hierarchy: 'Hierarchy',
    hierarchyOrchestratorMissing: 'No declared orchestrator',
    hierarchyOrchestratorMissingHint: 'No agent in this project declares the orchestrator role: the board never creates one.',
    hierarchyAgentsCount: '{n} agents',
    hierarchyHiddenByFilter: '{n} hidden by the filter',
    hierarchyNoAgents: 'No visible agent in this project.',
    hierarchyEmpty: 'No agent matches the filters.',
    hierarchyTeamOf: 'Team of {name}',
    activityReal: 'Real activity: {activity}',
    emptyFiltered: 'No agent matches the active filters.',
    clearFilters: 'Clear filters',
    noActivity: 'Activity unknown',
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

/**
 * Human-readable provenance of a DEDUCED role: the matched declared-text token,
 * or the explicit "no signal" default. Declared/generic roles return null (they
 * do not need an inference explanation).
 */
function dabInferenceReason(role) {
  if (role === null || role === undefined || role.source !== 'inferred') return null
  const inference = role.inference
  if (inference === null || typeof inference !== 'object') return dabT('roleInferred')
  if (inference.defaulted === true) return dabT('roleInferredDefault')
  const signal = typeof inference.token === 'string' && inference.token !== '' ? inference.token : inference.rule
  if (typeof signal === 'string' && signal !== '') return dabT('roleInferredFrom', { signal })
  return dabT('roleInferredDefault')
}

const DAB_STATUS_TEXT = {
  running: 'statusRunning',
  waiting_user: 'statusWaiting',
  recovering: 'statusRecovering',
  interrupted: 'statusInterrupted',
  provider_unavailable: 'statusProviderUnavailable',
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

/** Task Board workflow state: a SEPARATE vocabulary from the agent statuses. */
const DAB_TASK_STATE_TEXT = {
  todo: 'taskTodo',
  in_progress: 'taskInProgress',
  in_review: 'taskInReview',
  blocked: 'taskBlocked',
  done: 'taskDone',
  canceled: 'taskCanceled',
  archived: 'taskArchived',
}

function dabTaskStateLabel(state) {
  const key = DAB_TASK_STATE_TEXT[state]
  return key === undefined ? null : dabT(key)
}

/**
 * Translated count noun with a real singular form ("projet"/"projets"). Used
 * where the number is rendered separately (counters, chips).
 */
function dabCountNoun(count, singularKey, pluralKey) {
  const value = Number(count) || 0
  const key = typeof pluralKeyFor === 'function'
    ? pluralKeyFor(value, singularKey, pluralKey)
    : (Math.abs(value) === 1 ? singularKey : pluralKey)
  return dabT(key)
}

/** Translated count with a real singular form (the UI must never print
 * "1 projets"). The pure key choice lives in board/hierarchy.js. */
function dabCountLabel(count, singularKey, pluralKey) {
  const value = Number(count) || 0
  return `${value} ${dabCountNoun(value, singularKey, pluralKey)}`
}

/** "3 tours · 9 étapes" / "1 turn · 2 steps" — real counters only. */
function dabTurnStepLabel(turns, steps) {
  return `${dabCountLabel(turns, 'turnSingular', 'turnPlural')} · ${dabCountLabel(steps, 'stepSingular', 'stepPlural')}`
}

const DAB_FAMILY_TEXT = {
  governance: 'familyGovernance',
  coordination: 'familyCoordination',
  execution: 'familyExecution',
  quality: 'familyQuality',
  validation: 'familyValidation',
  protection: 'familyProtection',
}

function dabFamilyLabel(family) {
  const key = DAB_FAMILY_TEXT[family]
  return key === undefined ? null : dabT(key)
}

const DAB_SUPERVISION_STATUS_TEXT = {
  active: 'supervisionStatusActive',
  idle: 'supervisionStatusIdle',
  blocked: 'supervisionStatusBlocked',
}

function dabSupervisionStatusLabel(status) {
  const key = DAB_SUPERVISION_STATUS_TEXT[status]
  return key === undefined ? dabT('supervisionStatusUnknown') : dabT(key)
}

const DAB_RECOMMENDATION_TEXT = {
  delegate: 'recommendationDelegate',
  unblock: 'recommendationUnblock',
  priority: 'recommendationPriority',
  reassign: 'recommendationReassign',
}

function dabRecommendationLabel(kind) {
  const key = DAB_RECOMMENDATION_TEXT[kind]
  return key === undefined ? String(kind ?? '') : dabT(key)
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

/**
 * Chip text: the model name when known, else the provider, else null (the card
 * then renders the explicit "unknown model" label). Never a placeholder for a
 * value the board does not have.
 */
function dabModelText(model) {
  if (model === null || model === undefined || model.source === 'unknown') return null
  if (typeof model.model === 'string' && model.model !== '') return model.model
  if (typeof model.provider === 'string' && model.provider !== '') return model.provider
  return null
}

function dabModelTitle(model) {
  if (model === null || model === undefined || model.source === 'unknown') return dabT('noModel')
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  const source = model.source === 'assignment' ? ` · ${dabT('modelAssignment')}` : ` · ${dabT('modelNative')}`
  return `${provider}/${name}${effort}${source}`
}

/** Compact `provider/model` chip label for the inspector, null when unknown. */
function dabModelChipText(model) {
  if (model === null || model === undefined || model.source === 'unknown') return null
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  return `${provider}/${name}${effort}`
}

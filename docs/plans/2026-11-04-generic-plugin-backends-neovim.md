# Externaliser Neovim et ouvrir les backends de plugins

## Objectif et décisions approuvées

Extraire le mode full Neovim dans un plugin indépendant en ouvrant des
contrats réutilisables par d'autres plugins. La version de référence est
`v0.16.0` (la mention de `v0.26.0` était une coquille). L'implémentation
part de `main`, dans un worktree isolé.

- Fournir un éditeur intégré aux ouvertures de fichiers, à la recherche,
  à l'arbre et aux liens `file:line`.
- Conserver l'implémentation intégrée pendant une transition progressive.
- Créer un dépôt séparé pour le plugin, comme les connecteurs Pi et Vibe.
- Utiliser le `nvim` installé par l'utilisateur et sa configuration.
- Viser d'abord Electron sur macOS ARM/Intel et Linux x86_64. En accès
  distant web/mobile, utiliser CodeMirror avec une explication visible.
- Ne publier aucun paquet, dépôt ou message sans demande explicite.

## Contrats

### Transport générique

Conserver `backend.request()` et ajouter :

```ts
const subscription = await client.backend.subscribe("topic", handleEvent, {
  onResync,
  onError,
});
subscription.unsubscribe();
```

Le protocole natif v2 conserve `hello`, `ready`, `request` et `response` et
ajoute `event` avec un `topic` et un `payload` JSON. Les méthodes, topics et
payloads appartiennent au plugin. Le transport ne connaît ni Neovim ni les
terminaux.

Le service accepte v1 et v2. Le chemin HTTP v1 reste compatible ; le v2
passe par le broker authentifié sur socket. Le service ajoute une identité
de processus et une séquence monotone. Une reconnexion, un changement de
processus ou un débordement de file demande une resynchronisation.

Les files restent bornées. Un événement natif complet ne dépasse pas
`64 KiB` hors délimiteur de ligne ; un producteur découpe les messages plus
grands. Les entrées et requêtes à effet ne sont jamais rejouées
automatiquement. Les erreurs sont visibles. Les nouvelles capacités sont
annoncées au handshake ; un ancien hôte refuse explicitement les appels
qu'il ne prend pas en charge.

Conserver les grants par plugin/projet/conversation, le consentement, les
signatures et la révocation.

### Contribution d'éditeur et surfaces

Ajouter une contribution optionnelle `contributes.editor` : label et méthode
backend d'ouverture. Les paramètres communs sont
`EditorOpenFileParams { path, line?, column? }`, avec positions à partir de 1.

Le schéma de manifeste v2 accepte aussi les manifestes v1. Inclure la
contribution dans le hash de consentement uniquement quand elle existe pour
préserver les anciens hashes.

Introduire un registre d'éditeurs intégrés et de plugins actifs, le réglage
`editor_backend`, puis un contrôleur générique d'ouverture : disponibilité
de surface, acquittement du backend, focus. Quand le nouveau réglage manque,
préserver l'interprétation de `vim_mode_level`. Les mouvements Vim dans
CodeMirror restent distincts du choix de l'éditeur.

Partager l'hôte Electron isolé entre onglets et éditeurs avec des identités
de surfaces et des leases. Exposer au SDK l'identité, la visibilité, le
focus et l'apparence de l'éditeur (police monospace et taille), sans accès
général aux réglages ou au système de fichiers.

## Exécution par commits

Chaque commit suit RED → GREEN → VERIFY → COMMIT. Les vérifications
transversales finales sont exécutées une fois les contrats raccordés.

### 1. `feat(plugin-backends): add protocol v2 events`

Lecture requise : `docs/TAB_BACKEND_PROTOCOL.md`,
`packages/tab-backend-sdk-rs/{Cargo.toml,README.md,src/**,tests/**,examples/echo.rs}`,
`packages/plugin-core/src/tab/{mod.rs,execution.rs}` et les instructions de
construction/vérification du dépôt.

Écriture : ces contrats, le SDK Rust, ses tests, la validation des versions
dans plugin-core, les tests consommateurs du catalogue
(`packages/registry-core/src/tab_backend{.rs,/validate.rs}`), les fixtures de
protocoles futurs des tests `plugin_tabs/managed{.rs,/routes.rs}` du service
et le présent plan. Aucun nouveau raccordement UI/service.

- Documenter v2 et conserver les échanges v1.
- Ajouter les types d'événements et un émetteur clonable partageant l'écriture
  atomique de stdout avec les réponses.
- Accepter v1/v2 et répondre avec la version demandée dans `hello`.
- Valider les topics et la limite de taille ; retourner les erreurs d'émission.
- Adapter la conformance pour accepter les événements v2 valides sans
  conserver une file illimitée d'événements.
- Tester v1 inchangé, événements/réponses concurrents, événements invalides
  ou trop grands et fermeture de stdin avec un producteur en tâche de fond.
- Vérifier qu'un backend v2 signé est accepté par le catalogue ; utiliser v3
  pour les fixtures de protocole futur non installable.

Vérification : tests SDK avec toutes les features, tests plugin-core,
format/clippy, processus natifs réels et hook pre-commit requis.

### 2. `feat(plugin-backends): relay realtime events through the broker`

Lecture/écriture : superviseur natif, socket de plugins, broker TypeScript,
SDK tab, types/faux hôte, tests et exemple générique d'événements.

- Relayer requêtes et événements v2 sur la socket authentifiée.
- Ajouter abonnement, identité de processus, séquences et resynchronisation.
- Préserver le chemin HTTP v1 et l'isolation des grants.
- Tester lifecycle, révocation, isolation et backpressure.
- Valider dans l'app avec un exemple non lié à Neovim.

### 3. `feat(plugin-host): support embedded editor surfaces`

Lecture/écriture : hôte de surfaces Electron, leases, manifeste/hash/catalogue,
SDK identité/apparence, tests et éditeur factice.

- Extraire l'hôte partagé entre onglet et éditeur.
- Ajouter `contributes.editor`, schéma v2 et compatibilité des hashes v1.
- Gérer surfaces cachées/recyclées, focus et apparence.
- Tester un éditeur factice dans Electron.

### 4. `refactor(editor): route navigation through editor contributions`

Lecture/écriture : registre et contrôleur d'éditeur, réglages, ouvertures depuis
arbre/recherche/palette/conversation/diffs, tests et documentation.

- Raccorder toutes les ouvertures au contrôleur générique.
- Préserver CodeMirror, Preview et les raccourcis existants.
- Afficher les erreurs et le repli approprié.
- Vérifier navigation, focus et raccourcis QWERTY/AZERTY dans l'app.

### 5. `feat(neovim-plugin): implement the standalone editor`

Lecture/écriture : nouveau dépôt indépendant `cadencr-plugin-tab-neovim`.
Utiliser les SDK publics, sans dépendance de chemin vers CadencR.

- Wrapper Rust de `nvim` trouvé dans le PATH du login shell.
- PTY/socket, ouverture des fichiers et UI CeleriTTY.
- Un processus par conversation ; resize depuis la surface focalisée.
- Recréation après `:qa`.
- Abonnement avant attachement et snapshot avec séquence pour récupération.
- Tests `--clean`, vérification manuelle avec configuration réelle.
- Préparer builds et archives pour les trois plateformes, sans publication.

### 6. `feat(editor): add progressive Neovim plugin migration`

Lecture/écriture : flux existant d'installation/consentement/activation,
réglages d'éditeur, tests de migration et documentation.

- Migrer le réglage seulement après activation acquittée.
- Refuser la migration tant qu'une session Neovim intégrée est vivante ;
  demander à l'utilisateur de sauvegarder et quitter.
- Conserver l'ancien mode pendant la coexistence.
- Tester plugin indisponible/bloqué, consentement refusé et idempotence.

### 7. `refactor(neovim): remove the built-in editor implementation`

Condition préalable : une version de coexistence publiée, plugin disponible
et migration validée. Ne pas supprimer l'implémentation avant ce jalon.

Lecture/écriture : ancien manager/routes/WS/erreurs/dépendances Neovim,
liens directs, réglages de compatibilité, API générée et documentation.

- Retirer le code intégré et régénérer les contrats API.
- Lire encore les anciens réglages pour guider les utilisateurs non migrés.

## Vérifications transversales et limites

```bash
pnpm rust -- test -p cadencr-tab-backend --all-features
pnpm rust -- test -p cadencr-plugin-core
pnpm --filter @cadencr/tab-sdk test
pnpm --filter @cadencr/tab-sdk ts-check
pnpm --filter @cadencr/desktop ts-check
pnpm --filter @cadencr/desktop knip
pnpm test
pnpm lint
```

Exercer les comportements dans `pnpm dev`/Electron, y compris récupération
après déconnexion, changement de conversation, focus, ouverture `file:line`,
plugin désactivé et repli distant. Rapporter séparément les plateformes
effectivement exécutées et celles restant à vérifier.

Utiliser les réglages EAV existants ; aucune nouvelle table SQLite n'est
prévue. Ne jamais supprimer, remplacer ou écraser une base de données.

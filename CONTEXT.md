# Cadencr Extensibility

Cadencr users create local plugins in their own Cadencr instance. Sharing a
plugin is a separate, later workflow from creating and using it locally.

## Language

### Plugin

An extension authored for Cadencr. The local delivery scope includes themes,
provider connectors and custom tabs; a plugin does not inherently grant general
UI extension powers.

### Plugin project

A developer's Cadencr project dedicated to authoring an identifiable plugin:
a theme, a provider connector or a custom tab. Its identity persists independently of
its display name or folder, so it can later enter the publication workflow.

### Provider connector

A plugin that adapts an agent to Cadencr's supported provider contract. It is
not the upstream agent itself and is distinct from an installation of that plugin.

### Theme

A declarative plugin defining Cadencr's visual appearance through supported
theme values and inert visual assets. It does not execute an agent or script.
Its authoring project is distinct from the theme selected in the application.

### Custom tab

A plugin that adds a web UI tab to the feature page. It runs isolated from the
application, reaches Cadencr only through the tab SDK, and sees only what its
consented permissions allow. Enabling it is a per-project or global choice.

### Tab instance

One live rendering of a custom tab inside one feature page. Two features showing
the same custom tab are two instances with separate context and grants.

### Grant

The short-lived authority Cadencr issues to one tab instance: which plugin,
project, feature and permissions it may act for. It is never handed to the
plugin's code and expires on its own.

### Consent

The user's acceptance of a custom tab's declared permissions and network
origins. Widening either requires consent again.

### Managed theme

A verified installation of a published theme version. Its signed contents are
immutable; creating an editable derivative means creating a new plugin project.
Installation and activation are separate choices.

### Publication

The workflow that publishes a plugin version to its GitHub repository and
submits that initial or subsequent version to the Cadencr registry.

### Registry

The catalog of approved plugin identities and versions available for distribution.
It is not the list of local plugin projects or the list of installed plugins.

### Package version

One immutable, distributable version of a plugin. Its contents, identity and
publisher are distinct from an author's project and from a local installation.

### Release candidate

The complete set of artifacts proposed for one package version before publication.
A provider candidate includes every platform declared for that version.

### Publication delta

The new package versions, or exact replays, submitted in one publication batch.
It does not include the complete previously published history.

### Catalog renewal

Renewing the validity of a catalog while retaining its existing package versions.
It does not republish historical package artifacts.

### Publication operation

A tracked execution of a confirmed publication action. Its identity lets the
author retrieve the outcome after a connection or application interruption.

### Author provenance

The origin of a plugin's authored source and release. It identifies the author,
not necessarily the location from which an approved package is distributed.

### Distribution origin

The registry-approved origin serving a package's verified archive. Mirroring a
package changes its distribution origin, not its author provenance.

### Registry trust generation

A reviewed set of authorities for authenticating registry metadata. A successor
can retire an authority for historical evidence or revoke it after compromise.

### Recovery checkpoint

One exact historical metadata snapshot independently endorsed for continuity
recovery. It does not restore a revoked publisher's ordinary authority.

## Sessions

### Live status

The backend's answer to "what is this session doing now": idle, working, or
awaiting the user. Every connected device receives the same value; the desktop
never infers it from local state or user actions.
_Avoid_: agent status, session state.

### Turn lifecycle

The detailed phase of a conversation's current turn (active, paused and why,
ended and why, failed), as followed by the desktop. It refines live status for
display but never overrides it, and only backend events advance it.
_Avoid_: status.

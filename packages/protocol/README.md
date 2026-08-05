# `@raidiant/notifai-protocol`

The public wire contract used by the NotifAI CLI and service. It provides
TypeBox schemas and TypeScript types for notification drafts, REST v1
requests and responses, status vocabulary, lifecycle hints, and platform
capabilities.

```ts
import { CAPABILITIES_V1, validateDraft } from '@raidiant/notifai-protocol'
```

The package has no service implementation or private configuration. Node-only
helpers are available from `@raidiant/notifai-protocol/node`.

Licensed under Apache-2.0. See the repository-level `LICENSE` and `NOTICE`.

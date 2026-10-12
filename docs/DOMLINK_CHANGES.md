# DomLink fork: scene / group / selector improvements

## Scenes and groups

Domoticz uses `switchscene` for Scenes and Groups, but `switchlight` for
regular devices. Scenes are trigger-only and cannot be switched Off; Groups
can be switched both ways. A Scene's Matter switch resets its **Matter**
`OnOff` state to Off following each command, without sending an Off command
to Domoticz. This avoids changing group member devices or firing OffActions.

Domoticz Groups report `Mixed` when members have different states. Binary
Matter has no `Mixed` value; this fork maps it to On (at least one device On).

## Selectors

Selectors are classified as `SELECTOR` and presented to Matter as dimmable
lights. Domoticz `LevelNames` can be plain text or base64. The dashboard
shows actual named levels, and incoming percentages are snapped to valid
10-point steps. Existing `DIMMER` overrides of source Selectors are preserved.

Example: 30% -> Fan; 40% -> Heizen. Alexa voice mode names require external
routines; DomLink/Matter cannot advertise those mode words as HVAC operations.

Matter brightness is limited to 0-100%; larger Domoticz selectors are not
completely representable. If `LevelNames` are missing, levels are snapped
to 0,10,...,100 as a compatibility fallback.

## Test plan

1. `npm ci && npm test`; inspect GitHub Actions status.
2. Confirm normal switches still use `switchlight`.
3. Confirm a noncritical Scene uses `switchscene ... On` and Alexa's icon
   reverts to Off without a Domoticz Off command.
4. Confirm a Group accepts On and Off; `Mixed` is displayed as On in Alexa.
5. Confirm selector sends only valid mode levels (30/40), and its dashboard
   lists the labels Fan and Heizen.
6. Only after those checks, validate alarm-related routines carefully.

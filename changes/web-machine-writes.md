- The agent-machine web section gains writes through immutable
  proposals (#1295): POST /ui/api/machine/agent-machine/plan runs a
  signed plan round trip, and POST .../proposals creates a soul-less
  machine.<verb> proposal decided through the existing approvals flow —
  apply/update reach agent-machine only after an approved digest, with
  attribution harness 'web-ui' and no soul/session_id. Authorization
  uses assertMachineAuthorized: the principal needs the operation
  ('approve' for writes, 'observe' for the outcome view) on souls
  exactly ['*'].

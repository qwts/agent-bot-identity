- Add an internal POSIX journal for the dream scheduler: publish state and history
as one revision-checked transaction, retain uncertain leases across process
interruption, and expose bounded history and capacity status. This adds no dream
CLI or daemon job. Windows and macOS sudden-power-loss guarantees are not claimed.

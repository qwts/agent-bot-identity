- Web client gains a Settings section (#1295): GET /ui/api/machine/settings
  projects the secret-free config with per-key editable flags, and
  POST .../settings/proposals writes the settled editable keys
  (settings.daemonPreference, settings.skillSearchAdapter, features.*)
  through an immutable machine.settings proposal — approval re-validates
  the file's sha256 base (settings-drifted n100), applies changes
  preserving key order and file mode, and runs full config validation.

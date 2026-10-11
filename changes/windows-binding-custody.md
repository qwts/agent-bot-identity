- Windows daemon startup no longer calls a Unix-only UID API when its binding
  registry is absent. Persistent binding secrets and registry files now use
  native SID, protected file ACL, parent ancestry and file-identity checks on
  Windows; Unix ownership, mode and no-follow checks remain in place. Existing
  Git directory ACLs are inspected without alteration, and unsafe parents or
  file replacement cause refusal.
  Git directory authority checks compare native directory identities on Windows,
  accepting Git/Node path spelling differences without case-folding paths.
  Native parent inspection executes its complete stdin block and recognizes the
  fixed Windows Modules Installer SID only as a privileged ancestor owner.

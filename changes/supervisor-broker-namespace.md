- Supervised daemons retain the host-selected broker and credential paths
  across restart, and Windows tasks own their descendant process lifetime
  so stopping a task cannot leave its daemon behind (#934).

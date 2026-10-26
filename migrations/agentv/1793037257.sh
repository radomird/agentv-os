# TV setup installs the apps picked at its apps step through a hand-over to
# root: boxes installed before get it started now, so `agentv setup reset`
# can use it. New boxes get it from the package.
sudo systemctl start agentv-setup-apps.path || true

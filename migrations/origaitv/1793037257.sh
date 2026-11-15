# TV setup installs the apps picked at its apps step through a hand-over to
# root: boxes installed before get it started now, so `origaitv setup reset`
# can use it. New boxes get it from the package.
sudo systemctl start origaitv-setup-apps.path || true

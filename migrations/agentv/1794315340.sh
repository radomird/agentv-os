# The builder's home: boxes installed before get the folders a build now
# sees read-only (the provider's CLI, mise's tree, the CLI's own settings),
# so the build's unit has something to hold on to. New boxes get them from
# the package.
sudo systemd-tmpfiles --create agentv-builder.conf || true

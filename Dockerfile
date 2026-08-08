# Editmamei in a container, so MCP directories can enumerate its tools.
#
# Adobe ships no Linux build of Photoshop, so nothing in this image can edit a
# photo. What it can do is start the server, complete the MCP handshake, and
# report its tool surface — which is what a directory listing needs in order to
# show the real tools instead of guessing at them. Tool calls fail here, and say
# why. To drive an actual Photoshop, install on Windows or macOS; see the README.

FROM node:22-slim

# Install the published package rather than building this source tree. The source
# build needs a Go toolchain to compile the binary that generates Photoshop
# scripts, and the published package is what a user actually runs. Unpinned on
# purpose, so a rebuild picks up the current release.
RUN npm install -g editmamei && npm cache clean --force

# Drop root. The image's own unprivileged user already has a home directory,
# which the server needs — it keeps its settings there.
ENV HOME=/home/node
USER node

# Automated runs of this image are not installations. Usage reporting is
# opt-out, so turn it off here rather than have scanner runs counted as installs.
RUN editmamei config set telemetry.usage false

# No arguments starts the MCP server on stdio.
CMD ["editmamei"]

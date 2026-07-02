# Sim Phase 2 (docs/phase-0-simulation-plan.md) "EC2 app-server" stand-in.
# Not a production image: it simulates the assumed EC2 layout in a container
# so deployctl deploy backend can be demoed without real AWS/EC2 access.
FROM node:22-alpine

RUN apk add --no-cache bash curl

WORKDIR /opt/deployctl

COPY health-server.js entrypoint.sh secret-fixtures.json ./
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/opt/deployctl/entrypoint.sh"]

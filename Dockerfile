FROM node:24-alpine

# Install dependencies
RUN apk add --no-cache ca-certificates

# Copy project source
WORKDIR /app
COPY . .

# Bind all interfaces inside the container so the published port mapping works.
# This explicitly opts into LAN mode (access-token protected).
ENV HAMMER_HOST=0.0.0.0

# Expose the correct local router port
EXPOSE 7352

# Entrypoint: handles commands passed to the container
ENTRYPOINT ["node", "bin/hammer.js"]
CMD ["start"]


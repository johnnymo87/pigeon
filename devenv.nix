{ pkgs, ... }:
{
  packages = [
    pkgs.nodejs_22
  ];

  # Load secrets from .env for local development
  dotenv.enable = true;

  scripts.dev-daemon.exec = ''
    for f in ccr_worker_url ccr_api_key telegram_bot_token telegram_chat_id; do
      upper=$(echo "$f" | tr '[:lower:]' '[:upper:]')
      export "$upper"="$(cat /run/secrets/$f)"
    done
    npm run --workspace @pigeon/daemon dev -- "$@"
  '';

  scripts.dev-worker.exec = ''
    npm run --workspace @pigeon/worker dev -- "$@"
  '';

  enterShell = ''
    echo ""
    echo "Pigeon dev environment"
    echo "  Node: $(node --version)"
    echo ""
    echo "Commands:"
    echo "  npm install       - Install dependencies"
    echo "  npm run test      - Run all tests"
    echo "  npm run typecheck - Run typechecks"
    echo "  dev-daemon        - Start daemon (secrets from /run/secrets/)"
    echo "  dev-worker        - Start worker dev server"
    echo ""
  '';
}

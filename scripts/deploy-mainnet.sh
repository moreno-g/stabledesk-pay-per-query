#!/bin/zsh
# Déploie QueryPayments sur Arc mainnet (chain id 5042) avec un keystore Foundry chiffré.
# La clé privée n'apparaît jamais en clair : cast la demande une fois et la chiffre avec un mot de passe.
#
# Usage : zsh scripts/deploy-mainnet.sh [adresse_tresorerie]
#   Sans argument, la trésorerie est l'adresse qui déploie (elle est aussi propriétaire du contrat).
set -e
cd "$(dirname "$0")/.."

RPC=https://rpc.mainnet.arc.io
COMPTE=arc-mainnet
PRIX=10000000000000000   # 0,01 USDC en USDC natif (18 décimales)

[ "$(cast chain-id --rpc-url $RPC)" = "5042" ] || { echo "Ce RPC n'est pas Arc mainnet (5042) : arrêt."; exit 1; }

if ! cast wallet list 2>/dev/null | grep -qE "^$COMPTE( |$)"; then
  echo "Import de la clé du wallet qui déploie (une seule fois, chiffrée par un mot de passe) :"
  cast wallet import $COMPTE --interactive
fi

ADRESSE=$(cast wallet address --account $COMPTE)
TRESORERIE=${1:-$ADRESSE}
SOLDE=$(cast balance $ADRESSE --rpc-url $RPC --ether)
echo "Déployeur et propriétaire : $ADRESSE (solde $SOLDE USDC)"
echo "Trésorerie : $TRESORERIE"
node -e "process.exit(Number('$SOLDE') >= 0.05 ? 0 : 1)" || { echo "Il faut au moins 0,05 USDC sur Arc mainnet pour déployer : arrêt."; exit 1; }

forge create contracts/QueryPayments.sol:QueryPayments \
  --rpc-url $RPC --account $COMPTE --skip 'contracts/script/**' --broadcast \
  --constructor-args $TRESORERIE $PRIX

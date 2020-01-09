[![Netlify Status](https://api.netlify.com/api/v1/badges/d5aff6c9-ea09-4d75-98b7-4c40ccc0c592/deploy-status)](https://app.netlify.com/sites/jovial-hopper-4c504c/deploys)
# Rainbow Six Siege API

To learn more about the Rainbow Six Siege API, [read the docs](https://r6.elviswolcott.com/docs).

# Repository Structure

## SDK

The source for the SDK can be found in the `lib` directory. It's fairly simple, and a full explanation can be found in the docs.

## Docs

The source for the docs site exists in the `website` directory. It is built daily on Netlify and deployed to [r6.elviswolcott.com](https://r6.elviswolcott.com).

The docs content lives in `website/src/pages` as React components and in `website/docs` as Markdown. The site is built using [Docusaurus 2](https://github.com/facebook/docusaurus/) and configured in `website/docusaurus.config.js` and `website/sidebars.json`.

While most of the docs are written by hand, some pages are generated during the manfiest build process. They can be found in `website/docs/auto` AFTER running a build and **will not** be tracked in git.

## Scraper

The source for the scraper is in the `scraper` directory. Using puppeteer, it pulls information from various Ubisoft sites to build the manifest and associated documentation pages. It also pulls all of the image assets.

Make sure to create `scraper/.env` with a `UBI_EMAIL`, `UBI_PASSWORD`, and `UBI_ID` for your account.

The `UBI_ID` can be found by signing into `https://game-rainbow6.ubi.com` and will be in the URL in the form `https://game-rainbow6.ubi.com/en-us/{PLATFORM}/player-statistics/{UBI_ID}/multiplayer

# Contributing

Contributions are welcome! 

Create an issue or open a PR to if there's something you want added to the docs or SDK.
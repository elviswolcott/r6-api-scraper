[![Netlify Status](https://api.netlify.com/api/v1/badges/d5aff6c9-ea09-4d75-98b7-4c40ccc0c592/deploy-status)](https://app.netlify.com/sites/jovial-hopper-4c504c/deploys)
# R6 API Scraper

Using Puppeteer, the scraper pulls definition files from Ubisoft's site, records API requests, and scrapes pages for additional information. After scraping, all the referenced assets are downloaded.

This data is combined into the manifest. The manifest and recorded requests are used to generate markdown files for building the docs.

Docusaurus uses these files to build the [final website](https://r6.elviswolcott.com).


A Zapier task runs each day to rebuild the site to pull the latest data.

Contributions to add more documentation, examples etc. are welcome.

# TODO

* Release manifest to NPM
* scrape https://rainbow6.ubisoft.com for more info and add to manifest
* add api docs
* create API SDK
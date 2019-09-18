# R6 API Scraper

This script uses Puppeteer to run a virtual browser and perform basic scraping against the Rainbow Six Seige APIs.
It generates a definition file, downloads assets, and records API requests during the process. 
The resulting information can be found in the docs folder.
Each day, the scraper runs automatically and rebuilds the site if needed.

Contributions to add more documentation, examples etc. are welcome.

# TODO

* setup periodic builds to release the manifest and assets to NPM
* clean up scraper
* scrape https://rainbow6.ubisoft.com for more info
* typescript?
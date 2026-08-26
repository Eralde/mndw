import 'zone.js';
import 'zone.js/testing';
import {getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {installDomObserverStubs} from '@mndw/sdk/testing';
import {defineMndwTestComponents} from '@mndw/ui/testing';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

installDomObserverStubs();
defineMndwTestComponents();

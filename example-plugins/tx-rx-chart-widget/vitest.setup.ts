import 'zone.js';
import 'zone.js/testing';
import {getTestBed} from '@angular/core/testing';
import {BrowserTestingModule, platformBrowserTesting} from '@angular/platform-browser/testing';
import {defineMndwUi} from '@mndw/ui';

getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

defineMndwUi();

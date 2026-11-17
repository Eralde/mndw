import {MAX_UPLOAD_BYTES} from '../constants.js';
import {hostT} from './locale.service.js';

export function getUploadLimitLabel(): string {
  const megabytes = MAX_UPLOAD_BYTES / (1024 * 1024);

  return `${megabytes} ${hostT('settings.plugin-manager.upload-limit-unit')}`;
}

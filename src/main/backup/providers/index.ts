// Every storage Jolty can back up to, in the order the Account tab lists them.
import type { ProviderId } from '@shared/backup'
import type { Provider } from '../types'
import { box } from './box'
import { dropbox } from './dropbox'
import { folder } from './folder'
import { github } from './github'
import { google } from './google'
import { onedrive } from './onedrive'
import { s3 } from './s3'
import { webdav } from './webdav'

export const PROVIDERS: Provider[] = [google, onedrive, dropbox, box, github, webdav, s3, folder].filter(Boolean)

export const provider = (id: string): Provider | undefined => PROVIDERS.find((p) => p.id === (id as ProviderId))

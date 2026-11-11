// What the Library page lists (see main/library.ts): the pictures, files and links of every conversation.

export interface LibraryImage {
  sessionId: string
  title: string
  itemId: string
  index: number
  name: string
  at: number
}
export interface LibraryFile {
  sessionId: string
  title: string
  itemId: string
  name: string
  mime: string
  kind: 'video' | 'audio' | 'file'
  at: number
}
export interface LibraryLink {
  sessionId: string
  title: string
  url: string
  host: string
  at: number
}
export interface Library {
  images: LibraryImage[]
  files: LibraryFile[]
  links: LibraryLink[]
}

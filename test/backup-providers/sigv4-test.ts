// The signer against the worked examples in the AWS documentation (Amazon S3 Developer Guide, "Authenticating
// Requests: Using the Authorization Header", Example: GET Object and Example: PUT Object), so it is checked by
// numbers AWS published, not by this code.
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeKey, signV4, uriEncode } from '../../src/main/backup/sigv4'

const creds = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') }
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

test('AWS example: GET Object with a Range header', () => {
  const s = signV4({ ...creds, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' } })
  assert.equal(
    s.canonicalRequest,
    ['GET', '/test.txt', '', 'host:examplebucket.s3.amazonaws.com', 'range:bytes=0-9', `x-amz-content-sha256:${EMPTY}`, 'x-amz-date:20130524T000000Z', '', 'host;range;x-amz-content-sha256;x-amz-date', EMPTY].join('\n')
  )
  assert.equal(s.stringToSign, 'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972')
  assert.equal(s.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  assert.equal(
    s.headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
  )
})

test('AWS example: PUT Object with a body, extra headers and a key that needs encoding', () => {
  const body = Buffer.from('Welcome to Amazon S3.')
  const s = signV4({
    ...creds,
    method: 'PUT',
    url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    body
  })
  const hash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'
  assert.equal(s.headers['x-amz-content-sha256'], hash)
  assert.equal(
    s.canonicalRequest,
    ['PUT', '/test%24file.text', '', 'date:Fri, 24 May 2013 00:00:00 GMT', 'host:examplebucket.s3.amazonaws.com', `x-amz-content-sha256:${hash}`, 'x-amz-date:20130524T000000Z', 'x-amz-storage-class:REDUCED_REDUNDANCY', '', 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class', hash].join('\n')
  )
  assert.equal(s.stringToSign, 'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d')
  assert.equal(s.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
})

test('what is sent: no host header, lowercase names, the host of a non-default port is signed', () => {
  const s = signV4({ ...creds, method: 'HEAD', url: new URL('http://127.0.0.1:9000/bucket') })
  assert.equal(s.headers.host, undefined)
  assert.ok(s.canonicalRequest.includes('host:127.0.0.1:9000\n'))
  assert.deepEqual(Object.keys(s.headers).sort(), ['authorization', 'x-amz-content-sha256', 'x-amz-date'])
})

test('keys are encoded once, slashes kept, nothing normalized', () => {
  assert.equal(uriEncode("a b/c!'()*~._-é"), 'a%20b%2Fc%21%27%28%29%2A~._-%C3%A9')
  assert.equal(encodeKey('my folder/ünï//x.enc'), 'my%20folder/%C3%BCn%C3%AF//x.enc')
  const s = signV4({ ...creds, method: 'GET', url: new URL(`https://h.example/b/${encodeKey('a b//c%.enc')}`) })
  assert.equal(s.canonicalRequest.split('\n')[1], '/b/a%20b//c%25.enc')
})

test('the query string is sorted after encoding', () => {
  const s = signV4({ ...creds, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?prefix=somePrefix&marker=someMarker&max-keys=20') })
  assert.equal(s.canonicalRequest.split('\n')[2], 'marker=someMarker&max-keys=20&prefix=somePrefix')
})

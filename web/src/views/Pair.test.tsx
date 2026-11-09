import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pair } from './Pair'

const HELLO = { app: 'mori', version: '0.1.0', host: 'macmini', paired: false }
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

let reply: () => Response
let bodies: unknown[]

beforeEach(() => {
  bodies = []
  reply = () => new Response(null, { status: 204 })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return reply()
  }))
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
  history.replaceState(null, '', '/pair')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const codeBox = () => screen.getByLabelText('페어링 코드') as HTMLInputElement
const nameBox = () => screen.getByLabelText('이 기기 이름') as HTMLInputElement
const go = () => screen.getByRole('button', { name: '페어링' }) as HTMLButtonElement

describe('Pair', () => {
  it('takes the code from a pairing link and names the device', () => {
    history.replaceState(null, '', '/pair#code=abcd-efgh')
    render(<Pair hello={HELLO} onPaired={() => {}} />)
    expect(codeBox().value).toBe('ABCD-EFGH')
    expect(nameBox().value).toBe('iPhone · Safari')
    expect(screen.getByText('macmini').tagName).toBe('B')
    expect(go().disabled).toBe(false)
  })

  it('waits for the whole code and writes it as the server reads it', () => {
    render(<Pair hello={HELLO} onPaired={() => {}} />)
    expect(go().disabled).toBe(true)
    fireEvent.input(codeBox(), { target: { value: 'abcd' } })
    expect(go().disabled).toBe(true)
    fireEvent.input(codeBox(), { target: { value: 'abcdefgo' } })
    expect(codeBox().value).toBe('ABCD-EFG0')
    expect(go().disabled).toBe(false)
  })

  it('pairs with the code and the name', async () => {
    const onPaired = vi.fn()
    render(<Pair hello={HELLO} onPaired={onPaired} />)
    fireEvent.input(codeBox(), { target: { value: 'abcd-efgh' } })
    fireEvent.input(nameBox(), { target: { value: '  책상 아이폰 ' } })
    fireEvent.click(go())
    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce())
    expect(bodies).toEqual([{ code: 'ABCD-EFGH', name: '책상 아이폰' }])
  })

  it('says why the server refused and lets the person try again', async () => {
    reply = () =>
      new Response(JSON.stringify({ error: { kind: 'invalid_params', message: '코드가 맞지 않거나 만료되었습니다' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    const onPaired = vi.fn()
    render(<Pair hello={null} onPaired={onPaired} />)
    fireEvent.input(codeBox(), { target: { value: 'ABCDEFGH' } })
    fireEvent.click(go())
    expect((await screen.findByRole('alert')).textContent).toBe('코드가 맞지 않거나 만료되었습니다')
    expect(go().disabled).toBe(false)
    expect(onPaired).not.toHaveBeenCalled()
  })
})

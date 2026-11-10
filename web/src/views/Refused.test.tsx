import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../lib/api'
import { Refused } from './Refused'

describe('Refused', () => {
  it('says why the server would not answer at this address and what to open instead', () => {
    render(<Refused err={new ApiError(421, 'bad_host', '이 주소로는 Mori에 들어올 수 없습니다', 'Tailscale 이름으로 여세요')} />)
    expect(screen.getByRole('alert').textContent).toContain('이 주소로는 Mori에 들어올 수 없습니다')
    expect(screen.getByText(location.host).tagName).toBe('B')
    screen.getByText('Tailscale 이름으로 여세요')
  })
})

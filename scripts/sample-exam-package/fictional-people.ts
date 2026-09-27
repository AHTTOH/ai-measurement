import type { SeededRandom } from './random';

/**
 * 샘플 시험용 가공 인물 정보. 실존 인물과 무관하게 흔한 성과 이름을 무작위로 조합한다.
 * 주민등록번호·전화번호도 형식만 맞춘 가짜 값이다.
 */

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍'];
const GIVEN_NAMES = [
  '민준', '서연', '도윤', '하은', '지호', '수아', '예준', '지유', '시우', '서윤',
  '주원', '하린', '지훈', '채원', '준서', '지민', '현우', '다은', '건우', '소율',
  '우진', '예린', '선우', '유나', '연우', '가은', '정우', '수빈', '승현', '나연',
];

export class FictionalPeople {
  private readonly usedNames = new Set<string>();
  private readonly usedPhones = new Set<string>();

  constructor(private readonly random: SeededRandom) {}

  uniqueName(): string {
    for (;;) {
      const name = this.random.pick(SURNAMES) + this.random.pick(GIVEN_NAMES);
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name);
        return name;
      }
    }
  }

  uniqueMobile(): string {
    for (;;) {
      const phone = `010-${this.random.int(2000, 9899)}-${this.random.digits(4)}`;
      if (!this.usedPhones.has(phone)) {
        this.usedPhones.add(phone);
        return phone;
      }
    }
  }

  residentNumber(): string {
    const year = this.random.int(70, 99);
    const month = String(this.random.int(1, 12)).padStart(2, '0');
    const day = String(this.random.int(1, 28)).padStart(2, '0');
    const genderDigit = this.random.pick(['1', '2']);
    return `${year}${month}${day}-${genderDigit}${this.random.digits(6)}`;
  }

  email(index: number): string {
    return `customer${String(index).padStart(3, '0')}@example.com`;
  }
}

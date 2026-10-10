# 광고 자막용 한글 글꼴

다음 글꼴의 **수정하지 않은 TTF 원본**과 각 SIL Open Font License 1.1을 함께 배포한다. 원본 소스는 Google Fonts 저장소 커밋 `bd8f81ddb5c74d5c8897b36ad88b440266245103`이다.

- [Nanum Pen Script](https://github.com/google/fonts/tree/bd8f81ddb5c74d5c8897b36ad88b440266245103/ofl/nanumpenscript): 손글씨, LICENSE-nanumpenscript.txt
- [Black Han Sans](https://github.com/google/fonts/tree/bd8f81ddb5c74d5c8897b36ad88b440266245103/ofl/blackhansans): 강한 제목, LICENSE-blackhansans.txt
- [Jua](https://github.com/google/fonts/tree/bd8f81ddb5c74d5c8897b36ad88b440266245103/ofl/jua): 둥근 글꼴, LICENSE-jua.txt
- [Gowun Batang Bold](https://github.com/google/fonts/tree/bd8f81ddb5c74d5c8897b36ad88b440266245103/ofl/gowunbatang): 명조, LICENSE-gowunbatang.txt

`metrics.json`은 fontTools 4.63.0으로 TTF의 name/head/hhea/cmap/hmtx 테이블을 읽어 얻은 원본 SHA-256·unitsPerEm·행 높이·유니코드별 진행폭이다. 합성기는 이를 사용해 각 글꼴에 맞는 줄 폭을 계산한다. TTF 교체 시 반드시 함께 다시 추출하고 캐시 버전을 올린다. 글꼴 자체의 변경이나 서브셋 제작은 하지 않았다.
